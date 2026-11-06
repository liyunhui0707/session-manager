'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const failure = code => Object.assign(new Error(code), { code });
function createZstdTransport() {
  let cached = null, active = null, idleTimer = null, closing = null;
  async function discard() {
    clearTimeout(idleTimer);
    const old = cached; cached = null;
    if (old) {
      const pending = old.worker.terminate(); closing = pending;
      await pending;
      if (closing === pending) closing = null;
    } else if (closing) await closing;
  }
  return {
    isBusy: () => active !== null,
    read(data) {
      if (active) return Promise.reject(failure('READ_BUSY'));
      clearTimeout(idleTimer);
      const job = { worker: null, cancelled: false, completion: null };
      active = job;
      job.completion = (async () => {
        if (closing) await closing;
        if (cached && (cached.filePath !== data.filePath || cached.root !== data.canonicalRoot)) await discard();
        if (job.cancelled) throw failure('READ_CANCELLED');
        if (!cached) {
          const worker = new Worker(path.join(__dirname, 'codex-page-zstd-worker.js'), {
            workerData: { filePath: data.filePath, canonicalRoot: data.canonicalRoot },
            execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96 },
          });
          cached = { worker, filePath: data.filePath, root: data.canonicalRoot };
          worker.on('error', () => {}); // idle failures invalidate the cache via exit
          worker.once('exit', () => { if (cached?.worker === worker) cached = null; });
        }
        const worker = cached.worker; job.worker = worker; worker.ref();
        return new Promise((resolve, reject) => {
          let error = null;
          const timer = setTimeout(() => { error = failure('READ_TIMEOUT'); void worker.terminate(); }, 30000);
          const finish = (err, result) => {
            clearTimeout(timer);
            worker.removeListener('message', onMessage); worker.removeListener('exit', onExit);
            worker.removeListener('error', onError);
            worker.unref();
            if (err) reject(err); else resolve(result);
          };
          const onMessage = message => {
            if (job.cancelled || error) return; // only exit acknowledges termination
            finish(message.ok ? null : failure(message.code), message.result);
          };
          const onError = () => { error = failure('READ_FAILED'); };
          const onExit = () => finish(job.cancelled ? failure('READ_CANCELLED') : error || failure('READ_FAILED'));
          worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
          worker.postMessage({ offset: data.offset || 0, snapshot: data.snapshot });
        });
      })().finally(() => {
        if (active === job) active = null;
        if (cached) { idleTimer = setTimeout(() => { void discard(); }, 60000); idleTimer.unref(); }
      });
      return job.completion;
    },
    async cancel() {
      if (!active) return false;
      const job = active; job.cancelled = true;
      if (job.worker) await job.worker.terminate();
      await job.completion.catch(() => {});
      return true;
    },
    async close() { await this.cancel(); await discard(); },
  };
}
module.exports = { createZstdTransport };
