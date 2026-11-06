'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
test('cancellation ignores a late result and keeps the read locked until worker termination', async () => {
  let worker, release;
  class FakeWorker extends EventEmitter {
    constructor() { super(); worker = this; }
    postMessage() {}
    ref() {}
    unref() {}
    terminate() {
      this.emit('message', { ok: true, result: {} });
      return new Promise(resolve => { release = () => { this.emit('exit', 1); resolve(1); }; });
    }
  }
  const filename = path.join(__dirname, '../../tools/legacy-reader/codex-page-zstd-transport.js');
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(filename), setTimeout, clearTimeout,
    require: id => id === 'node:worker_threads' ? { Worker: FakeWorker } : require(id) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
  const transport = sandbox.module.exports.createZstdTransport();
  const pending = transport.read({ filePath: '/synthetic/rollout-a.jsonl.zst', canonicalRoot: '/synthetic' });
  let settled = false;
  pending.catch(() => { settled = true; });
  const cancelled = transport.cancel();
  await new Promise(resolve => setImmediate(resolve));
  try { assert.ok(worker); assert.equal(settled, false); assert.equal(transport.isBusy(), true); }
  finally { release(); await cancelled; }
  await assert.rejects(pending, { code: 'READ_CANCELLED' });
});
