'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { scanCodexSourceTree } = require('../../lib/codex-source-traversal');

const OUTPUT_MAGIC = Buffer.from('ASMO\x02', 'binary');
const FRAME = { PROBE: 1, ENTRY: 2, INDEX: 3, COMPLETE: 4 };
const STATUS = { MISSING: 0, SAFE: 1, UNSAFE: 2, ERROR: 3 };

function frame(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function probe(sessions, archive = STATUS.MISSING, index = STATUS.MISSING) {
  return frame(FRAME.PROBE, Buffer.from([sessions, archive, index]));
}

function entry(area, relativePath, { size = 12n, seconds = 100n, nanoseconds = 500000000 } = {}) {
  const pathBytes = Buffer.from(relativePath, 'utf8');
  const payload = Buffer.alloc(25 + pathBytes.length);
  payload.writeUInt8(area, 0);
  payload.writeBigUInt64BE(size, 1);
  payload.writeBigInt64BE(seconds, 9);
  payload.writeUInt32BE(nanoseconds, 17);
  payload.writeUInt32BE(pathBytes.length, 21);
  pathBytes.copy(payload, 25);
  return frame(FRAME.ENTRY, payload);
}

function complete({ skipped = 0, visited = 1, peakRssBytes = 4096n, reasons = [0, 0, 0, 0, skipped] } = {}) {
  const payload = Buffer.alloc(36);
  payload.writeUInt32BE(skipped, 0);
  payload.writeUInt32BE(visited, 4);
  payload.writeBigUInt64BE(peakRssBytes, 8);
  reasons.forEach((count, i) => payload.writeUInt32BE(count, 16 + i * 4));
  return frame(FRAME.COMPLETE, payload);
}

function fakeChild(onInput) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on('data', (chunk) => onInput(child, chunk));
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

function validSpawn(capture = {}) {
  return (command, args, options) => {
    Object.assign(capture, { command, args, options });
    let phase = 0;
    return fakeChild((child, chunk) => {
      if (phase === 0) {
        capture.rootInput = Buffer.from(chunk);
        phase = 1;
        child.stdout.write(Buffer.concat([
          OUTPUT_MAGIC,
          probe(STATUS.SAFE, STATUS.SAFE, STATUS.SAFE),
        ]));
        return;
      }
      capture.planInput = Buffer.from(chunk);
      child.stdout.end(Buffer.concat([
        entry(0, 'sessions/2026/09/01/rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'),
        entry(1, 'archived_sessions/rollout-2026-08-01T10-00-00-22222222-2222-4222-8222-222222222222.jsonl'),
        frame(FRAME.INDEX, Buffer.from('{"synthetic":true}\n')),
        complete({ skipped: 2, visited: 8, peakRssBytes: 8192n }),
      ]));
      queueMicrotask(() => child.emit('close', 0, null));
    });
  };
}

test('development Electron uses the project helper while packaged Electron uses Resources/bin', async (t) => {
  const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  const previousDefaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
  t.after(() => {
    for (const [key, descriptor] of [['resourcesPath', previousResources], ['defaultApp', previousDefaultApp]]) {
      if (descriptor) Object.defineProperty(process, key, descriptor);
      else delete process[key];
    }
  });
  Object.defineProperty(process, 'resourcesPath', { value: '/synthetic/Electron.app/Contents/Resources', configurable: true });
  Object.defineProperty(process, 'defaultApp', { value: true, configurable: true });
  const development = {};
  await scanCodexSourceTree('/synthetic/root', { platform: 'darwin', spawn: validSpawn(development) });
  assert.equal(development.command, require('node:path').resolve(__dirname, '../../build/native/codex-source-helper'));

  Object.defineProperty(process, 'defaultApp', { value: undefined, configurable: true });
  const packaged = {};
  await scanCodexSourceTree('/synthetic/root', { platform: 'darwin', spawn: validSpawn(packaged) });
  assert.equal(packaged.command, '/synthetic/Electron.app/Contents/Resources/bin/codex-source-helper');
});

test('main-owned wrapper sends the root through stdin and accepts one complete bounded full-root scan', async () => {
  const capture = {};
  const result = await scanCodexSourceTree('/synthetic/root', {
    platform: 'darwin',
    helperPath: '/fixed/app/codex-source-helper',
    spawn: validSpawn(capture),
  });

  assert.equal(capture.command, '/fixed/app/codex-source-helper');
  assert.deepEqual(capture.args, []);
  assert.equal(capture.options.shell, false);
  assert.equal(JSON.stringify([capture.command, capture.args]).includes('/synthetic/root'), false);
  assert.equal(capture.rootInput.includes(Buffer.from('/synthetic/root')), true);
  assert.equal(capture.planInput.at(-1), 1, 'JavaScript must select the full-root plan');
  assert.equal(result.layout, 'full');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].area, 'active');
  assert.equal(result.candidates[1].area, 'archive');
  assert.equal(result.indexContent, '{"synthetic":true}\n');
  assert.deepEqual(result.diagnostics, { skipped: 2, errors: 0, indexErrors: 0, skippedReasons: { compressed: 0, unsupportedName: 0, layout: 0, unsafe: 0, other: 2 } });
  assert.equal(result.helperPeakRssBytes, 8192);
  assert.ok(result.parentPeakRssBytes > 0);
});

for (const [name, output] of [
  ['truncated frame', Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE), Buffer.from([FRAME.ENTRY, 0, 0, 0, 20, 1])])],
  ['missing completion', Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE), entry(0, '2026/09/01/rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl')])],
  ['absolute entry path', Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE), entry(0, '/outside/rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'), complete()])],
  ['escaping entry path', Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE), entry(0, '../outside/rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'), complete()])],
]) {
  test(`wrapper rejects ${name} without returning partial metadata`, async () => {
    const spawn = () => {
      let phase = 0;
      return fakeChild((child) => {
        if (phase++ === 0) child.stdout.write(Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE)]));
        else {
          child.stdout.end(output.subarray(OUTPUT_MAGIC.length + probe(STATUS.SAFE).length));
          queueMicrotask(() => child.emit('close', 0, null));
        }
      });
    };
    await assert.rejects(
      scanCodexSourceTree('/synthetic/root', { platform: 'darwin', helperPath: '/fixed/helper', spawn }),
      (error) => error && error.code === 'SCAN_PROTOCOL_ERROR',
    );
  });
}

test('unsupported platforms fail closed without spawning a helper', async () => {
  let spawned = false;
  await assert.rejects(
    scanCodexSourceTree('/synthetic/root', {
      platform: 'win32',
      spawn: () => { spawned = true; },
    }),
    (error) => error && error.code === 'PLATFORM_UNSUPPORTED',
  );
  assert.equal(spawned, false);
});

test('cancellation terminates the helper and rejects buffered partial output', async () => {
  const controller = new AbortController();
  let child;
  const spawn = () => {
    let phase = 0;
    child = fakeChild((running) => {
      if (phase++ === 0) running.stdout.write(Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE)]));
      else running.stdout.write(entry(0,
        'sessions/2026/09/01/rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'));
    });
    return child;
  };
  const pending = scanCodexSourceTree('/synthetic/root', {
    platform: 'darwin', helperPath: '/fixed/helper', spawn, signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, (error) => error?.code === 'SCAN_CANCELLED');
  assert.equal(child.killed, true);
});

test('a missing fixed helper is reported as platform unsupported', async () => {
  await assert.rejects(
    scanCodexSourceTree('/synthetic/root', {
      platform: 'darwin', helperPath: '/definitely/missing/codex-source-helper',
    }),
    (error) => error?.code === 'PLATFORM_UNSUPPORTED',
  );
});

for (const [name, firstOutput] of [
  ['malformed protocol magic', Buffer.from('WRONG', 'ascii')],
  ['an oversized frame', Buffer.concat([OUTPUT_MAGIC, Buffer.from([FRAME.PROBE, 0, 16, 0, 1])])],
  ['a frame before the probe', Buffer.concat([OUTPUT_MAGIC,
    entry(0, 'sessions/2026/09/01/rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl')])],
]) {
  test(`wrapper rejects ${name}`, async () => {
    const spawn = () => fakeChild((child) => {
      child.stdout.end(firstOutput);
      queueMicrotask(() => child.emit('close', 0, null));
    });
    await assert.rejects(
      scanCodexSourceTree('/synthetic/root', { platform: 'darwin', helperPath: '/fixed/helper', spawn }),
      (error) => error?.code === 'SCAN_PROTOCOL_ERROR',
    );
  });
}

test('wrapper rejects a nonzero helper exit even after a completion frame', async () => {
  const spawn = () => {
    let phase = 0;
    return fakeChild((child) => {
      if (phase++ === 0) child.stdout.write(Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE)]));
      else {
        child.stdout.end(complete());
        queueMicrotask(() => child.emit('close', 9, null));
      }
    });
  };
  await assert.rejects(
    scanCodexSourceTree('/synthetic/root', { platform: 'darwin', helperPath: '/fixed/helper', spawn }),
    (error) => error?.code === 'SCAN_FAILED',
  );
});

for (const [name, completion] of [
  ['inconsistent skip totals', complete({ skipped: 2, reasons: [1, 0, 0, 0, 0] })],
  ['skip totals exceeding visited entries', complete({ skipped: 3, visited: 1 })],
  ['legacy short completion', frame(FRAME.COMPLETE, Buffer.alloc(16))],
]) {
  test(`wrapper rejects ${name} instead of publishing misleading diagnostics`, async () => {
    const spawn = () => {
      let phase = 0;
      return fakeChild(child => {
        if (phase++ === 0) child.stdout.write(Buffer.concat([OUTPUT_MAGIC, probe(STATUS.SAFE)]));
        else { child.stdout.end(completion); queueMicrotask(() => child.emit('close', 0, null)); }
      });
    };
    await assert.rejects(scanCodexSourceTree('/synthetic/root', { platform: 'darwin', spawn }), { code: 'SCAN_PROTOCOL_ERROR' });
  });
}

test('legacy helper protocol is rejected rather than accepted without skip reasons', async () => {
  const spawn = () => {
    let sent = false;
    return fakeChild(child => {
      if (sent) return;
      sent = true;
      child.stdout.end(Buffer.concat([Buffer.from('ASMO\x01', 'binary'), probe(STATUS.SAFE),
        frame(FRAME.COMPLETE, Buffer.alloc(16))]));
      queueMicrotask(() => child.emit('close', 0, null));
    });
  };
  await assert.rejects(scanCodexSourceTree('/synthetic/root', { platform: 'darwin', spawn }), { code: 'SCAN_PROTOCOL_ERROR' });
});
