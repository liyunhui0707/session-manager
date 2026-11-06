import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleepDefault } from 'node:timers/promises';
import { spawn as spawnDefault } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kibToBytes, validateMetrics, workerMain } from './benchmark-codex-report.mjs';

const require = createRequire(import.meta.url);
const { scanCodexSource } = require('../lib/codex-source-catalog');

export async function measureCancellation(root, options = {}) {
  const scan = options.scan || scanCodexSource;
  const spawn = options.spawn || spawnDefault;
  const controller = new AbortController();
  let child, closed = false, started, rejectionMs, closeMs, timeout;
  let resolveClose;
  const closure = new Promise(resolve => { resolveClose = resolve; });
  const trackedSpawn = (...args) => {
    child = spawn(...args);
    child.once('close', () => {
      closed = true;
      closeMs = started === undefined ? undefined : performance.now() - started;
      resolveClose();
    });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      if (Buffer.isBuffer(chunk) && chunk.length === 6 && chunk.subarray(0, 5).equals(Buffer.from('ASMP\x02', 'binary'))) {
        // Production has received the probe; hold the plan while the actual helper waits.
        started = performance.now();
        queueMicrotask(() => controller.abort());
        return true;
      }
      return write(chunk, ...rest);
    };
    return child;
  };
  try {
    const rejected = scan(root, { signal: controller.signal, spawn: trackedSpawn }).then(
      () => { throw new Error('Cancellation resolved unexpectedly'); },
      error => {
        if (started === undefined || error.code !== 'SCAN_CANCELLED') throw new Error('Cancellation not observed');
        rejectionMs = performance.now() - started;
      });
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Cancellation deadline exceeded')), options.deadlineMs || 2000);
    });
    await Promise.race([Promise.all([rejected, closure]), deadline]);
    if (!Number.isFinite(closeMs)) throw new Error('Helper closed before cancellation');
    return { rejectionMs, closeMs, reason: 'SCAN_CANCELLED' };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (child && !closed) {
      child.kill('SIGKILL');
      let cleanupTimer;
      try {
        await Promise.race([closure, new Promise((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error('Helper cleanup failed')), 2000);
        })]);
      } finally { clearTimeout(cleanupTimer); }
    }
  }
}

export async function measureScan(root, count, options = {}) {
  const scan = options.scan || scanCodexSource;
  const rss = options.rss || (() => process.memoryUsage.rss());
  const highWaterKiB = options.highWaterKiB || (() => process.resourceUsage().maxRSS);
  const now = options.now || (() => performance.now());
  const sleep = options.sleep || sleepDefault;
  const baselineRssBytes = rss();
  let sampledPeakRssBytes = baselineRssBytes;
  const sample = () => { const current = rss(); sampledPeakRssBytes = Math.max(sampledPeakRssBytes, current); return current; };
  const timer = setInterval(sample, 5);
  try {
    const started = now();
    const catalog = await scan(root, options.spawn ? { spawn: options.spawn } : {});
    const scanMs = now() - started;
    const retainedImmediateRssBytes = sample();
    await sleep(100);
    const retainedIdleRssBytes = sample();
    const parentHighWaterBytes = kibToBytes(highWaterKiB());
    const helperPeakRssBytes = catalog.scanMetrics.helperPeakRssBytes;
    const metrics = { baselineRssBytes, sampledPeakRssBytes, parentHighWaterBytes,
      retainedImmediateRssBytes, retainedIdleRssBytes, helperPeakRssBytes,
      combinedBytes: parentHighWaterBytes + helperPeakRssBytes, scanMs };
    // Validation allocates after the measurement boundary; the entire catalog stays live until here.
    const entries = catalog.entries;
    const ids = new Set(entries.map(entry => entry.sessionId));
    if (entries.length !== count || ids.size !== count) throw new Error('Invalid catalog count');
    for (let index = 0; index < count; index++) {
      if (!ids.has(`aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`)) {
        throw new Error('Invalid catalog identity');
      }
    }
    validateMetrics(metrics);
    return { entries: entries.length, uniqueEntries: ids.size, metrics };
  } finally { clearInterval(timer); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const children = new Map();
  const spawn = (...args) => {
    const child = spawnDefault(...args);
    const closure = new Promise(resolve => child.once('close', () => { children.delete(child); resolve(); }));
    children.set(child, closure);
    return child;
  };
  const cleanup = async () => {
    const closures = [...children.values()];
    for (const child of children.keys()) child.kill('SIGKILL');
    let timer;
    try {
      await Promise.race([Promise.all(closures), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Helper cleanup failed')), 1500);
      })]);
    } finally { clearTimeout(timer); }
  };
  process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(2)); });
  await workerMain(['warmup', 'scan', 'cancel'], async ({ root, count, mode }) => {
    try {
      return mode === 'cancel' ? await measureCancellation(root, { spawn }) : await measureScan(root, count, { spawn });
    } finally { await cleanup(); }
  });
}
