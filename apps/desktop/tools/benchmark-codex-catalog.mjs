import { randomUUID, createHash } from 'node:crypto';
import { spawn as spawnDefault } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { snapshotFixture } from './benchmark-codex-fixture.mjs';
import { COUNTS, secondBatchReasons, summarizeScans, summarizeCancellation,
  validateWorkerReport } from './benchmark-codex-report.mjs';

export function runProcess(request, {
  spawn = spawnDefault, timeoutMs = 30000, killGraceMs = 2000, closeGraceMs = 2000,
} = {}) {
  return new Promise((resolve, reject) => {
    const script = request.mode === 'generate' ? './benchmark-codex-fixture.mjs' : './benchmark-codex-worker.mjs';
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    let child;
    try { child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env }); }
    catch { reject(new Error('Benchmark process failed')); return; }
    let output = '', bytes = 0, errorBytes = 0, failed = false, ended = false, settled = false;
    let killTimer, closeTimer;
    const clearTimers = () => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
    };
    const kill = signal => { try { child.kill(signal); } catch {} };
    const fail = () => {
      if (failed || settled) return;
      failed = true;
      killTimer = setTimeout(() => {
        closeTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimers();
          // Release parent handles so incomplete evidence can be printed. Exit is NOT confirmed.
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          child.unref();
          reject(Object.assign(new Error('Benchmark worker termination unconfirmed'), {
            code: 'BENCHMARK_TERMINATION_UNCONFIRMED',
          }));
        }, closeGraceMs);
        kill('SIGKILL');
      }, killGraceMs);
      kill('SIGTERM');
    };
    const timer = setTimeout(fail, timeoutMs);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) fail();
      else output += chunk.toString('utf8');
    });
    child.stdout.on('end', () => { ended = true; });
    child.stderr.on('data', chunk => {
      errorBytes += Buffer.byteLength(chunk);
      if (errorBytes > 8192) fail();
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      try {
        if (failed || !ended || code !== 0 || signal) throw new Error();
        const result = validateWorkerReport(JSON.parse(output), request);
        if (result.pid !== child.pid) throw new Error();
        resolve(result);
      } catch { reject(new Error('Invalid benchmark process report')); }
    });
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 8192) fail();
    else child.stdin.end(input);
  });
}

export async function scheduleSize(count, run, afterGeneration = async () => {}) {
  if (!COUNTS.includes(count)) throw new Error('Invalid fixture size');
  const result = { count, generation: null, warmup: null, runs: [], cancellations: [],
    secondBatchReasons: [], errors: [] };
  let stopped = false;
  async function attempt(mode) {
    const request = { runId: randomUUID(), mode, count };
    try {
      return validateWorkerReport(await run(request), request);
    } catch (error) {
      stopped = error?.code === 'BENCHMARK_TERMINATION_UNCONFIRMED';
      result.errors.push({ runId: request.runId, mode,
        reason: stopped ? 'worker-termination-unconfirmed' : 'attempt-invalid' });
      return null;
    }
  }
  result.generation = await attempt('generate');
  if (result.generation) {
    try { await afterGeneration(); }
    catch { result.errors.push({ mode: 'verify', reason: 'fixture-invalid' }); }
    if (!result.errors.length) result.warmup = await attempt('warmup');
    if (result.warmup) {
      for (let index = 0; index < 5 && !stopped; index++) result.runs.push(await attempt('scan'));
      if (!stopped && result.runs.every(Boolean)) {
        result.secondBatchReasons = secondBatchReasons(result.runs.map(row => row.metrics));
        if (result.secondBatchReasons.length) {
          for (let index = 0; index < 5 && !stopped; index++) result.runs.push(await attempt('scan'));
        }
      }
      for (let index = 0; index < 5 && !stopped; index++) result.cancellations.push(await attempt('cancel'));
    }
  }
  result.scans = summarizeScans(result.runs.map(row => row?.metrics), count);
  result.cancellation = summarizeCancellation(result.cancellations.filter(Boolean));
  return result;
}

export async function runSize(count, { run = runProcess } = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-isolated-benchmark-'));
  const root = path.join(workspace, 'source');
  let before, result;
  try {
    result = await scheduleSize(count, request => run({ ...request, root }), async () => {
      before = await snapshotFixture(root);
    });
    result.readOnly = 'INCONCLUSIVE';
    if (result.errors.some(error => error.reason === 'worker-termination-unconfirmed')) {
      result.cleanup = 'UNCONFIRMED';
    }
    if (before && result.cleanup !== 'UNCONFIRMED') {
      try { result.readOnly = isDeepStrictEqual(before, await snapshotFixture(root)) ? 'PASS' : 'FAIL'; }
      catch { result.readOnly = 'FAIL'; }
    }
    return result;
  } finally {
    // Never inspect/delete the source of a worker whose termination is unconfirmed.
    if (result?.cleanup !== 'UNCONFIRMED') {
      try {
        await fs.rm(workspace, { recursive: true, force: true });
        if (result) result.cleanup = 'CONFIRMED';
      } catch (error) {
        if (!result) throw error;
        result.cleanup = 'UNCONFIRMED';
        result.errors.push({ mode: 'cleanup', reason: 'fixture-cleanup-failed' });
      }
    }
  }
}

export function exitCodeFor(results) {
  if (!results.length || results.some(row => row.readOnly !== 'PASS' || row.errors.length ||
      row.cleanup === 'UNCONFIRMED' || row.scans.validity !== 'VALID' || row.cancellation.verdict === 'INCONCLUSIVE')) return 2;
  return results.some(row => row.scans.memory === 'FAIL' || row.scans.timing === 'FAIL' ||
    row.cancellation.verdict === 'FAIL') ? 1 : 0;
}

export async function collectSizes(results, measure = runSize) {
  for (const count of COUNTS) {
    const result = await measure(count);
    results.push(result);
    if (exitCodeFor([result]) === 2 || result.scans.reproducedBreach) break;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = { version: 1, scope: 'Node scanner plus native helper; not whole-app Electron memory',
    timestamp: new Date().toISOString(), environment: { node: process.version, platform: process.platform,
      arch: process.arch, osRelease: os.release(), physicalMemoryBytes: os.totalmem() }, results: [] };
  try {
    if (process.versions.node.split('.')[0] !== '24' || process.platform !== 'darwin' || process.env.NODE_OPTIONS) {
      throw new Error('Unsupported benchmark runtime');
    }
    const hashes = {};
    for (const relative of ['../build/native/codex-source-helper', '../native/codex-source-helper.c',
      '../lib/codex-source-catalog.js', '../lib/codex-source-traversal.js']) {
      const bytes = await fs.readFile(new URL(relative, import.meta.url));
      hashes[path.basename(relative)] = createHash('sha256').update(bytes).digest('hex');
    }
    report.hashes = hashes;
    await collectSizes(report.results);
    report.exitCode = exitCodeFor(report.results);
    if (report.results.length !== COUNTS.length && report.exitCode === 0) report.exitCode = 2;
  } catch {
    report.error = 'Benchmark incomplete';
    report.exitCode = 2;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.exitCode;
}
