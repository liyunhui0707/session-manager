'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
let benchmark;

test.before(async () => {
  benchmark = await import('../../tools/benchmark-codex-catalog.mjs');
});

function report(request, pid, combinedBytes = 60 * 1024 * 1024) {
  const base = { version: 1, runId: request.runId, mode: request.mode, count: request.count, pid };
  if (request.mode === 'generate') return { ...base, files: request.count };
  if (request.mode === 'cancel') return { ...base, rejectionMs: 1, closeMs: 2, reason: 'SCAN_CANCELLED' };
  return { ...base, entries: request.count, uniqueEntries: request.count, metrics: {
    baselineRssBytes: 20000000, sampledPeakRssBytes: 30000000,
    parentHighWaterBytes: combinedBytes - 1048576,
    retainedImmediateRssBytes: 30000000, retainedIdleRssBytes: 30000000,
    helperPeakRssBytes: 1048576, combinedBytes, scanMs: 2,
  } };
}

test('generation exits before warmup and five distinct measured and cancellation invocations', async () => {
  let running = false, generated = false, pid = 1000;
  const calls = [];
  const result = await benchmark.scheduleSize(100, async request => {
    assert.equal(running, false, 'no concurrent workers');
    running = true;
    if (request.mode !== 'generate') assert.equal(generated, true);
    await new Promise(resolve => setImmediate(resolve));
    const row = report(request, ++pid);
    calls.push(row);
    if (request.mode === 'generate') generated = true;
    running = false;
    return row;
  });
  assert.deepEqual(calls.map(row => row.mode), ['generate', 'warmup', ...Array(5).fill('scan'), ...Array(5).fill('cancel')]);
  assert.equal(new Set(calls.map(row => row.runId)).size, 12);
  assert.equal(new Set(calls.map(row => row.pid)).size, 12);
  assert.equal(result.runs.length, 5);
  assert.equal(result.cancellations.length, 5);
  assert.equal(result.scans.memory, 'PASS');
});

test('conditional second batch runs once and retains failures and raw observations', async () => {
  let pid = 1000, measured = 0;
  const result = await benchmark.scheduleSize(10000, async request => {
    const high = request.mode === 'scan' && ++measured <= 5;
    return report(request, ++pid, high ? 157286401 : 60 * 1024 * 1024);
  });
  assert.equal(measured, 10);
  assert.equal(result.runs.length, 10);
  assert.equal(result.runs[0].metrics.combinedBytes, 157286401);
  assert.equal(result.scans.memory, 'FAIL');
  assert.equal(result.scans.reproducedBreach, false);
  assert.deepEqual(result.secondBatchReasons, ['above-142.5-MiB']);
});

test('generator failure produces incomplete evidence without launching a scanner', async () => {
  const calls = [];
  const result = await benchmark.scheduleSize(100, async request => {
    calls.push(request.mode);
    throw new Error('/private/synthetic-error');
  });
  assert.deepEqual(calls, ['generate']);
  assert.equal(result.scans.validity, 'INCONCLUSIVE');
  assert.equal(JSON.stringify(result).includes('/private'), false);
});

test('measurement includes final catalog construction and idle retention before validating entries', async () => {
  const { measureScan } = await import('../../tools/benchmark-codex-worker.mjs');
  let rss = 20000000, highKiB = 20000, clock = 0, scans = 0, slept = false;
  const entries = Array.from({ length: 100 }, (_, i) => ({ sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, '0')}` }));
  const result = await measureScan('/synthetic', 100, {
    async scan() {
      scans++;
      rss = 90000000; highKiB = 100000; clock = 12;
      return {
        // This deliberately disagrees with the wrapper's earlier, lower sample.
        scanMetrics: { parentPeakRssBytes: 21000000, helperPeakRssBytes: 1048576 },
        get entries() { assert.equal(slept, true); return entries; },
      };
    },
    rss: () => rss, highWaterKiB: () => highKiB, now: () => clock,
    async sleep(ms) { assert.equal(ms, 100); rss = 80000000; clock += ms; slept = true; },
  });
  assert.equal(scans, 1);
  assert.equal(result.metrics.baselineRssBytes, 20000000);
  assert.equal(result.metrics.sampledPeakRssBytes, 90000000);
  assert.equal(result.metrics.parentHighWaterBytes, 102400000);
  assert.equal(result.metrics.retainedImmediateRssBytes, 90000000);
  assert.equal(result.metrics.retainedIdleRssBytes, 80000000);
  assert.equal(result.metrics.combinedBytes, 103448576);
  assert.equal(result.metrics.scanMs, 12);
  assert.equal(result.uniqueEntries, 100);
});

test('wrong or duplicate catalog entries fail measurement instead of reporting a cheap successful scan', async () => {
  const { measureScan } = await import('../../tools/benchmark-codex-worker.mjs');
  for (const entries of [[], Array(100).fill({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000000' })]) {
    await assert.rejects(measureScan('/synthetic', 100, {
      scan: async () => ({ entries, scanMetrics: { helperPeakRssBytes: 1048576 } }),
      sleep: async () => {},
    }), /catalog/i);
  }
});

function childWithOutput(output, { code = 0, stderr = '', waitForKill = false } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = signal => {
    child.killed = signal;
    queueMicrotask(() => {
      child.stdout.end(); child.stderr.end();
      child.emit('close', null, signal);
    });
    return true;
  };
  child.stdin.on('data', () => {
    if (waitForKill) return;
    child.stderr.end(stderr);
    child.stdout.end(output);
    setImmediate(() => child.emit('close', code, null));
  });
  return child;
}

test('worker transport sends private root through stdin and resolves only after valid output and zero exit', async () => {
  const request = { runId: 'run-transport', mode: 'scan', count: 100, root: '/private/synthetic' };
  const value = report(request, 123);
  let closed = false, input = '', seenArgs;
  const result = await benchmark.runProcess(request, {
    spawn(command, args, options) {
      assert.equal(command, process.execPath);
      assert.equal(options.shell, false);
      seenArgs = args;
      const child = childWithOutput(JSON.stringify(value) + '\n');
      child.stdin.on('data', bytes => { input += bytes; });
      child.on('close', () => { closed = true; });
      return child;
    },
  });
  assert.equal(closed, true);
  assert.equal(seenArgs.join(' ').includes('/private/synthetic'), false);
  assert.equal(JSON.parse(input).root, '/private/synthetic');
  assert.deepEqual(result, value);
});

test('transport rejects malformed, duplicate, oversized, incomplete, wrong-identity and nonzero-exit reports', async () => {
  const request = { runId: 'run-transport', mode: 'scan', count: 100, root: '/private/synthetic' };
  const json = JSON.stringify(report(request, 123));
  for (const [output, options] of [
    ['{', {}], ['', {}], [json + '\n' + json, {}], ['x'.repeat(65537), {}],
    [json, { code: 1 }], [json, { stderr: 'x'.repeat(8193) }],
    [JSON.stringify({ ...report(request, 123), runId: 'wrong' }), {}],
    [JSON.stringify(report(request, 999)), {}],
  ]) {
    await assert.rejects(benchmark.runProcess(request, {
      spawn: () => childWithOutput(output, options),
    }), error => !error.message.includes('/private'));
  }
});

test('timeout terminates its owned worker and waits for closure before rejecting', async () => {
  const child = childWithOutput('', { waitForKill: true });
  let closed = false;
  child.on('close', () => { closed = true; });
  await assert.rejects(benchmark.runProcess({ runId: 'timeout', mode: 'scan', count: 100, root: '/private/synthetic' }, {
    spawn: () => child, timeoutMs: 10,
  }));
  assert.equal(child.killed, 'SIGTERM');
  assert.equal(closed, true);
});

test('fresh workers do not inherit Node instrumentation or CI reporter options', async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--test-reporter=tap';
  try {
    const request = { runId: 'clean-options', mode: 'scan', count: 100, root: '/synthetic' };
    let environment;
    await benchmark.runProcess(request, { spawn: (_command, _args, options) => {
      environment = options.env;
      return childWithOutput(JSON.stringify(report(request, 123)));
    } });
    assert.ok(environment);
    assert.equal(Object.hasOwn(environment, 'NODE_OPTIONS'), false);
    assert.equal(process.env.NODE_OPTIONS, '--test-reporter=tap');
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test('fixture generator creates only requested synthetic files and refuses an existing root', async () => {
  const fixture = await import('../../tools/benchmark-codex-fixture.mjs');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-benchmark-test-'));
  const root = path.join(workspace, 'source');
  try {
    assert.equal(await fixture.generateFixture(root, 100), 100);
    const rows = await fixture.snapshotFixture(root);
    assert.equal(rows.filter(row => row.type === 'file').length, 100);
    assert.equal(rows.filter(row => row.type === 'file').every(row => row.size === '0'), true);
    await assert.rejects(fixture.generateFixture(root, 100));
    assert.deepEqual(await fixture.snapshotFixture(root), rows);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('external snapshot detects content, metadata, additions, removals and symlinks without following them', async () => {
  const fixture = await import('../../tools/benchmark-codex-fixture.mjs');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-benchmark-snapshot-'));
  try {
    const target = path.join(workspace, 'file');
    await fs.writeFile(target, 'synthetic');
    const before = await fixture.snapshotFixture(workspace);
    await fs.writeFile(target, 'different');
    assert.notDeepEqual(await fixture.snapshotFixture(workspace), before);
    const edited = await fixture.snapshotFixture(workspace);
    await fs.chmod(target, 0o400);
    assert.notDeepEqual(await fixture.snapshotFixture(workspace), edited);
    await fs.symlink('missing-synthetic-target', path.join(workspace, 'link'));
    const linked = await fixture.snapshotFixture(workspace);
    assert.equal(linked.find(row => row.type === 'link').target, 'missing-synthetic-target');
    assert.equal(linked.length, before.length + 1);
    await fs.unlink(target);
    assert.equal((await fixture.snapshotFixture(workspace)).length, before.length);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

function cancellationHarness({ closeDelay = 20, ignoreTerm = false, resolveInstead = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  let forwarded = false, closed = false;
  child.stdin.on('data', () => { forwarded = true; });
  child.kill = signal => {
    if (ignoreTerm && signal === 'SIGTERM') return true;
    setTimeout(() => { closed = true; child.emit('close', null, signal); }, closeDelay);
    return true;
  };
  return {
    child, isClosed: () => closed, wasForwarded: () => forwarded,
    spawn: () => child,
    scan: (_root, { spawn: launch, signal }) => new Promise((resolve, reject) => {
      const launched = launch('fixed-helper', [], { shell: false });
      signal.addEventListener('abort', () => {
        launched.kill('SIGTERM');
        if (resolveInstead) resolve({});
        else reject(Object.assign(new Error('Cancelled'), { code: 'SCAN_CANCELLED' }));
      });
      launched.stdin.write(Buffer.from('ASMP\x02\x01', 'binary'), () => {});
    }),
  };
}

test('cancellation holds the scan plan and separately measures rejection and actual helper closure', async () => {
  const worker = await import('../../tools/benchmark-codex-worker.mjs');
  const harness = cancellationHarness();
  const result = await worker.measureCancellation('/synthetic', harness);
  assert.equal(result.reason, 'SCAN_CANCELLED');
  assert.ok(result.closeMs >= result.rejectionMs + 10);
  assert.equal(harness.isClosed(), true);
  assert.equal(harness.wasForwarded(), false);
});

test('cancellation cannot pass with successful resolution or a helper requiring forced cleanup', async () => {
  const worker = await import('../../tools/benchmark-codex-worker.mjs');
  for (const config of [{ resolveInstead: true }, { ignoreTerm: true }]) {
    const harness = cancellationHarness(config);
    await assert.rejects(worker.measureCancellation('/synthetic', { ...harness, deadlineMs: 40 }));
    assert.equal(harness.isClosed(), true);
  }
});

test('real generator, fresh scan workers and cancellation preserve the synthetic source', {
  skip: process.platform !== 'darwin' || process.versions.node.split('.')[0] !== '24',
}, async () => {
  const fixture = await import('../../tools/benchmark-codex-fixture.mjs');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-benchmark-integration-'));
  const root = path.join(workspace, 'source');
  const pids = new Set([process.pid]);
  try {
    const generation = await benchmark.runProcess({ runId: 'generate-100', mode: 'generate', count: 100, root });
    pids.add(generation.pid);
    const before = await fixture.snapshotFixture(root);
    for (const mode of ['warmup', 'scan', 'scan', 'cancel']) {
      const value = await benchmark.runProcess({ runId: `${mode}-${pids.size}`, mode, count: 100, root });
      assert.equal(pids.has(value.pid), false);
      pids.add(value.pid);
      if (mode === 'cancel') assert.ok(value.closeMs >= 0 && value.rejectionMs >= 0);
      else {
        assert.equal(value.entries, 100);
        assert.ok(value.metrics.parentHighWaterBytes >= value.metrics.retainedImmediateRssBytes);
      }
    }
    assert.equal(pids.size, 6);
    assert.deepEqual(await fixture.snapshotFixture(root), before);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('worker input rejects extra, oversized, relative-root and unsupported-mode requests', async () => {
  const { readRequest } = await import('../../tools/benchmark-codex-report.mjs');
  const good = { runId: 'input-1', mode: 'scan', count: 100, root: '/synthetic' };
  for (const value of [{ ...good, extra: true }, { ...good, root: '../synthetic' },
    { ...good, mode: 'unknown' }, { ...good, root: '/' + 'x'.repeat(9000) }]) {
    const stream = new PassThrough();
    stream.end(JSON.stringify(value));
    await assert.rejects(readRequest(['scan'], stream));
  }
  const stream = new PassThrough();
  stream.end(JSON.stringify(good));
  assert.deepEqual(await readRequest(['scan'], stream), good);
});

test('coordinator externally verifies read-only state and invalidates evidence on mutation', async () => {
  const fixture = await import('../../tools/benchmark-codex-fixture.mjs');
  for (const mutate of [false, true]) {
    let root, pid = 500, cancellation = 0;
    const result = await benchmark.runSize(100, { run: async request => {
      root = request.root;
      if (request.mode === 'generate') await fixture.generateFixture(root, 100);
      if (request.mode === 'cancel' && ++cancellation === 5 && mutate) {
        await fs.writeFile(path.join(root, 'unexpected-output'), 'synthetic');
      }
      return report(request, pid++);
    } });
    assert.equal(result.readOnly, mutate ? 'FAIL' : 'PASS');
    assert.equal(benchmark.exitCodeFor([result]), mutate ? 2 : 0);
    assert.equal(JSON.stringify(result).includes(root), false);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  }
});

test('exit verdict keeps valid budget failures distinct from incomplete or invalid evidence', () => {
  const result = { readOnly: 'PASS', errors: [], scans: { validity: 'VALID', memory: 'PASS', timing: 'PASS' },
    cancellation: { verdict: 'PASS' } };
  assert.equal(benchmark.exitCodeFor([result]), 0);
  assert.equal(benchmark.exitCodeFor([{ ...result, scans: { ...result.scans, memory: 'FAIL' } }]), 1);
  assert.equal(benchmark.exitCodeFor([{ ...result, scans: { ...result.scans, validity: 'INCONCLUSIVE', memory: 'FAIL' } }]), 2);
  assert.equal(benchmark.exitCodeFor([]), 2);
});

test('cleanup failure preserves all completed measurements and budget failures as incomplete evidence', async () => {
  const { generateFixture } = await import('../../tools/benchmark-codex-fixture.mjs');
  const remove = fs.rm;
  let workspace, pid = 1000;
  fs.rm = async (target, options) => {
    if (target === workspace) throw new Error('private synthetic cleanup failure');
    return remove(target, options);
  };
  try {
    const result = await benchmark.runSize(100, { run: async request => {
      workspace = path.dirname(request.root);
      if (request.mode === 'generate') await generateFixture(request.root, 100);
      return report(request, ++pid, 157286401);
    } });
    assert.equal(result.runs.length, 10);
    assert.equal(result.runs.every(row => row.metrics.combinedBytes === 157286401), true);
    assert.ok(result.generation && result.warmup);
    assert.equal(result.cancellations.length, 5);
    assert.equal(result.scans.memory, 'FAIL');
    assert.equal(result.scans.reproducedBreach, true);
    assert.equal(result.readOnly, 'PASS');
    assert.equal(result.cleanup, 'UNCONFIRMED');
    assert.deepEqual(result.errors, [{ mode: 'cleanup', reason: 'fixture-cleanup-failed' }]);
    assert.equal(benchmark.exitCodeFor([result]), 2);
    assert.equal(JSON.stringify(result).includes('private synthetic'), false);
    assert.ok((await fs.stat(workspace)).isDirectory());
  } finally {
    fs.rm = remove;
    if (workspace) await remove(workspace, { recursive: true, force: true });
  }
});

test('missing close after both termination signals rejects within a bounded deadline without claiming exit', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  child.unref = () => { child.unreferenced = true; };
  let watchdog;
  const pending = benchmark.runProcess({ runId: 'never-close', mode: 'scan', count: 100, root: '/synthetic' }, {
    spawn: () => child, timeoutMs: 10, killGraceMs: 10, closeGraceMs: 10,
  }).then(() => 'unexpected success', error => error);
  try {
    const outcome = await Promise.race([pending, new Promise(resolve => {
      watchdog = setTimeout(() => resolve('still pending'), 500);
    })]);
    assert.notEqual(outcome, 'still pending');
    assert.equal(outcome.code, 'BENCHMARK_TERMINATION_UNCONFIRMED');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.unreferenced, true);
    assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
  } finally {
    clearTimeout(watchdog);
    child.stdout.end(); child.stderr.end();
    await new Promise(resolve => setImmediate(resolve));
    child.emit('close', null, 'SIGKILL');
    await pending;
  }
});

test('close observed after escalation remains a confirmed failed attempt', async () => {
  const child = childWithOutput('', { waitForKill: true });
  const kill = child.kill;
  child.kill = signal => signal === 'SIGTERM' ? true : kill(signal);
  await assert.rejects(benchmark.runProcess({ runId: 'late-close', mode: 'scan', count: 100, root: '/synthetic' }, {
    spawn: () => child, timeoutMs: 10, killGraceMs: 10, closeGraceMs: 50,
  }), error => error.code !== 'BENCHMARK_TERMINATION_UNCONFIRMED');
  assert.equal(child.killed, 'SIGKILL');
});

test('unconfirmed termination stops every scheduling phase and retains earlier budget failures', async () => {
  for (const failedAttempt of [0, 1, 3, 8, 12]) {
    const calls = [];
    const result = await benchmark.scheduleSize(100, async request => {
      calls.push(request.mode);
      if (calls.length === failedAttempt + 1) throw Object.assign(new Error('private termination detail'), {
        code: 'BENCHMARK_TERMINATION_UNCONFIRMED',
      });
      return report(request, 1000 + calls.length, 157286401);
    });
    assert.equal(calls.length, failedAttempt + 1);
    assert.equal(result.errors[0].reason, 'worker-termination-unconfirmed');
    if (failedAttempt >= 3) {
      assert.equal(result.scans.memory, 'FAIL');
      assert.equal(result.runs[0].metrics.combinedBytes, 157286401);
    }
    assert.equal(JSON.stringify(result).includes('private termination'), false);
  }
});

test('unconfirmed termination skips verification and deletion of the potentially live worker source', async () => {
  const { generateFixture } = await import('../../tools/benchmark-codex-fixture.mjs');
  const remove = fs.rm, lstat = fs.lstat;
  let unconfirmed = false, workspace, scans = 0, postFailureOperations = 0;
  fs.rm = async (...args) => { if (unconfirmed) postFailureOperations++; return remove(...args); };
  fs.lstat = async (...args) => { if (unconfirmed) postFailureOperations++; return lstat(...args); };
  try {
    const result = await benchmark.runSize(100, { run: async request => {
      workspace = path.dirname(request.root);
      if (request.mode === 'generate') await generateFixture(request.root, 100);
      if (request.mode === 'scan' && ++scans === 2) {
        unconfirmed = true;
        throw Object.assign(new Error('unconfirmed'), { code: 'BENCHMARK_TERMINATION_UNCONFIRMED' });
      }
      return report(request, 123, 157286401);
    } });
    assert.equal(postFailureOperations, 0);
    assert.equal(result.cleanup, 'UNCONFIRMED');
    assert.equal(result.readOnly, 'INCONCLUSIVE');
    assert.equal(result.scans.memory, 'FAIL');
    assert.equal(result.cancellations.length, 0);
    assert.equal(benchmark.exitCodeFor([result]), 2);
    assert.ok((await lstat(workspace)).isDirectory());
  } finally {
    fs.rm = remove; fs.lstat = lstat;
    if (workspace) await remove(workspace, { recursive: true, force: true });
  }
});

test('unconfirmed cleanup stops later sizes without losing accumulated reports', async () => {
  for (const reason of ['fixture-cleanup-failed', 'worker-termination-unconfirmed']) {
    const results = [], counts = [];
    await benchmark.collectSizes(results, async count => {
      counts.push(count);
      return { count, runs: [{ metrics: { combinedBytes: count === 100 ? 60000000 : 157286401 } }],
        errors: count === 100 ? [] : [{ mode: 'cleanup', reason }],
        readOnly: 'PASS', cleanup: count === 100 ? 'CONFIRMED' : 'UNCONFIRMED',
        scans: { validity: 'VALID', memory: count === 100 ? 'PASS' : 'FAIL', timing: 'PASS' },
        cancellation: { verdict: 'PASS' } };
    });
    assert.deepEqual(counts, [100, 1000]);
    assert.equal(results.length, 2);
    assert.equal(results[1].runs[0].metrics.combinedBytes, 157286401);
    assert.equal(benchmark.exitCodeFor(results), 2);
  }
});
