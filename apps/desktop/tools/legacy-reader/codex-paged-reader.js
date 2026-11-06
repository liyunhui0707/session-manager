'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const failure = code => Object.assign(new Error(code), { code });
const MAX_PAGES = 100000;

function createCodexPagedReader() {
  let current = null, active = null, compressed = null, reading = false;
  async function run(data) {
    if (reading) throw failure('READ_BUSY');
    reading = true;
    try {
      if (data.filePath.endsWith('.jsonl.zst')) {
        compressed ||= require('./codex-page-zstd-transport').createZstdTransport();
        return await compressed.read(data);
      }
      if (compressed) await compressed.close();
      return await runPlain(data);
    } finally { reading = false; }
  }
  function runPlain(data) {
    if (active) return Promise.reject(failure('READ_BUSY'));
    const worker = new Worker(path.join(__dirname, 'codex-page-worker.js'), {
      workerData: data, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    const task = { worker, cancelled: false, error: null, result: null };
    active = task;
    const timer = setTimeout(() => { task.error = failure('READ_TIMEOUT'); void worker.terminate(); }, 30000);
    return new Promise((resolve, reject) => {
      worker.on('message', message => { task.result = message; });
      worker.on('error', () => { task.error = failure('READ_FAILED'); });
      // A message is not completion: release the lock only after worker exit.
      worker.once('exit', code => {
        clearTimeout(timer);
        if (active === task) active = null;
        if (task.cancelled) reject(failure('READ_CANCELLED'));
        else if (task.error) reject(task.error);
        else if (code !== 0 || !task.result) reject(failure('READ_FAILED'));
        else if (!task.result.ok) reject(failure(task.result.code));
        else resolve(task.result.result);
      });
    });
  }
  function publish(state, result) {
    return {
      name: state.source.name,
      sourceBytes: result.snapshot.size,
      conversation: result.conversation,
      page: { readerId: state.id, number: state.index + 1, hasPrevious: state.index > 0,
        hasNext: result.compressed ? result.hasNext : result.nextOffset < result.snapshot.size,
        compressed: !!result.compressed, scannedBytes: result.nextOffset,
        totalBytes: result.compressed ? null : result.snapshot.size },
    };
  }
  return {
    async open(source) {
      const result = await run({ filePath: source.filePath, canonicalRoot: source.canonicalRoot });
      const state = { source: { ...source }, id: randomUUID(), index: 0,
        offsets: [0, result.nextOffset], hasNext: result.compressed ? result.hasNext : result.nextOffset < result.snapshot.size,
        snapshot: result.snapshot };
      current = state;
      return publish(state, result);
    },
    async move(id, direction) {
      if (!current || current.id !== id) throw failure('STALE_READER');
      if (!['next', 'previous'].includes(direction)) throw failure('INVALID_REQUEST');
      const state = current;
      const index = state.index + (direction === 'next' ? 1 : -1);
      const offset = state.offsets[index];
      if (index < 0 || index >= MAX_PAGES || offset === undefined || (direction === 'next' && !state.hasNext)) throw failure('PAGE_UNAVAILABLE');
      const result = await run({ ...state.source, offset, snapshot: state.snapshot });
      if (current !== state) throw failure('STALE_READER');
      state.hasNext = result.compressed ? result.hasNext : result.nextOffset < result.snapshot.size;
      state.index = index;
      state.offsets[index + 1] = result.nextOffset;
      return publish(state, result);
    },
    getSource: () => current && current.source,
    async close() { await this.cancel(); await compressed?.close(); current = null; },
    async cancel() {
      if (compressed?.isBusy()) return compressed.cancel();
      if (!active) return false;
      const task = active;
      task.cancelled = true;
      await task.worker.terminate();
      return true;
    },
  };
}
module.exports = { createCodexPagedReader };
