import path from 'node:path';

export const MEMORY_LIMIT = 157286400;
export const SECOND_BATCH_THRESHOLD = 149422080;
export const COUNTS = [100, 1000, 10000];
const TIME_LIMITS = { 100: 500, 1000: 1500, 10000: 8000 };
const MEMORY_KEYS = ['baselineRssBytes', 'sampledPeakRssBytes', 'parentHighWaterBytes',
  'retainedImmediateRssBytes', 'retainedIdleRssBytes', 'helperPeakRssBytes', 'combinedBytes'];

function invalid() { throw new Error('Invalid benchmark report'); }
function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
}
function duration(value) {
  if (!Number.isFinite(value) || value < 0) invalid();
}
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) invalid();
}

export async function readRequest(modes, input = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) invalid();
    chunks.push(Buffer.from(chunk));
  }
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  keys(request, ['runId', 'mode', 'count', 'root']);
  if (typeof request.runId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.runId) ||
      !modes.includes(request.mode) || !COUNTS.includes(request.count) ||
      typeof request.root !== 'string' || !path.isAbsolute(request.root) ||
      path.resolve(request.root) !== request.root || request.root.includes('\0') || request.root === '/') invalid();
  return request;
}

export async function workerMain(modes, run) {
  try {
    if (process.versions.node.split('.')[0] !== '24' || process.env.NODE_OPTIONS) invalid();
    const request = await readRequest(modes);
    const fields = await run(request);
    const { runId, mode, count } = request;
    const report = { version: 1, runId, mode, count, pid: process.pid, ...fields };
    validateWorkerReport(report, request);
    const output = JSON.stringify(report) + '\n';
    if (Buffer.byteLength(output) > 65536) invalid();
    process.stdout.write(output);
  } catch {
    process.stderr.write('Benchmark worker failed\n');
    process.exitCode = 2;
  }
}

export function kibToBytes(value) {
  positiveInteger(value);
  const bytes = value * 1024;
  positiveInteger(bytes);
  return bytes;
}

export function validateMetrics(metrics) {
  keys(metrics, [...MEMORY_KEYS, 'scanMs']);
  for (const key of MEMORY_KEYS) positiveInteger(metrics[key]);
  duration(metrics.scanMs);
  const observed = Math.max(metrics.baselineRssBytes, metrics.sampledPeakRssBytes,
    metrics.retainedImmediateRssBytes, metrics.retainedIdleRssBytes);
  if (metrics.parentHighWaterBytes < observed || metrics.sampledPeakRssBytes < metrics.baselineRssBytes ||
      metrics.combinedBytes !== metrics.parentHighWaterBytes + metrics.helperPeakRssBytes) invalid();
  return metrics;
}

export function validateWorkerReport(report, request) {
  const common = ['version', 'runId', 'mode', 'count', 'pid'];
  if (!report || report.version !== 1 || !/^[a-zA-Z0-9-]{1,80}$/.test(report.runId) ||
      !COUNTS.includes(report.count) || !['generate', 'warmup', 'scan', 'cancel'].includes(report.mode)) invalid();
  for (const key of ['runId', 'mode', 'count']) if (report[key] !== request[key]) invalid();
  positiveInteger(report.pid);
  if (report.mode === 'generate') {
    keys(report, [...common, 'files']);
    if (report.files !== request.count) invalid();
  } else if (report.mode === 'cancel') {
    keys(report, [...common, 'rejectionMs', 'closeMs', 'reason']);
    duration(report.rejectionMs);
    duration(report.closeMs);
    if (report.reason !== 'SCAN_CANCELLED') invalid();
  } else {
    keys(report, [...common, 'entries', 'uniqueEntries', 'metrics']);
    if (report.entries !== request.count || report.uniqueEntries !== request.count) invalid();
    validateMetrics(report.metrics);
  }
  return report;
}

export function statistics(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { minimum: sorted[0], median, maximum: sorted.at(-1),
    spread: sorted.at(-1) - sorted[0], relativeSpread: median ? (sorted.at(-1) - sorted[0]) / median : 0 };
}

export function secondBatchReasons(rows) {
  if (rows.length !== 5) invalid();
  rows.forEach(validateMetrics);
  const stats = statistics(rows.map(row => row.combinedBytes));
  return [
    ...(stats.maximum > SECOND_BATCH_THRESHOLD ? ['above-142.5-MiB'] : []),
    ...(stats.relativeSpread > 0.20 ? ['spread-above-20-percent'] : []),
  ];
}

export function needsSecondBatch(rows) { return secondBatchReasons(rows).length > 0; }

export function summarizeScans(rows, count) {
  if (!COUNTS.includes(count)) invalid();
  const good = [];
  let malformed = false;
  for (const row of rows) {
    try { good.push(validateMetrics(row)); } catch { malformed = true; }
  }
  const requiresSecond = !malformed && rows.length >= 5 && needsSecondBatch(rows.slice(0, 5));
  const complete = !malformed && rows.length === (requiresSecond ? 10 : 5);
  const breached = good.some(row => row.combinedBytes > MEMORY_LIMIT);
  return {
    validity: complete ? 'VALID' : 'INCONCLUSIVE',
    memory: breached ? 'FAIL' : complete ? 'PASS' : 'INCONCLUSIVE',
    timing: good.some(row => row.scanMs > TIME_LIMITS[count]) ? 'FAIL' : complete ? 'PASS' : 'INCONCLUSIVE',
    samples: rows.length,
    reproducedBreach: complete && requiresSecond &&
      rows.slice(0, 5).some(row => row.combinedBytes > MEMORY_LIMIT) &&
      rows.slice(5).some(row => row.combinedBytes > MEMORY_LIMIT),
    combined: statistics(good.map(row => row.combinedBytes)),
    scanMs: statistics(good.map(row => row.scanMs)),
  };
}

export function summarizeCancellation(rows) {
  const valid = rows.every(row => Number.isFinite(row.rejectionMs) && row.rejectionMs >= 0 &&
    Number.isFinite(row.closeMs) && row.closeMs >= 0 && row.reason === 'SCAN_CANCELLED');
  return {
    verdict: !valid || rows.length !== 5 ? 'INCONCLUSIVE'
      : rows.some(row => row.rejectionMs > 250 || row.closeMs > 250) ? 'FAIL' : 'PASS',
    rejectionMs: valid ? statistics(rows.map(row => row.rejectionMs)) : null,
    closeMs: valid ? statistics(rows.map(row => row.closeMs)) : null,
  };
}
