'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { toPublicCatalog } = require('./codex-source-catalog');
const failure = code => Object.assign(new Error(code), { code });
const MAX_ENTRIES = 50000; // Same bound as the native metadata catalog.

function createBrowsingScanner(scanMetadata, { workerPath = path.join(__dirname, 'codex-page-origin-task.js'), timeoutMs = 30000 } = {}) {
  // One selected source, memory only; never persist paths, headers or transcript text.
  let cacheRoot = null, cache = new Map();
  async function classify(catalog, signal) {
    if (signal?.aborted) throw failure('SCAN_CANCELLED');
    if (catalog.entries.length > MAX_ENTRIES) throw failure('ORIGIN_FAILED');
    const entries = catalog.entries.map(e => ({ source: { filePath: e.filePath,
      canonicalRoot: catalog.canonicalRoot, sessionId: e.sessionId },
    cached: cacheRoot === catalog.canonicalRoot ? cache.get(e.filePath) : undefined }));
    const worker = new Worker(workerPath, { workerData: { entries }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 96 } });
    return new Promise((resolve, reject) => {
      let result, error;
      const stop = code => { error = failure(code); void worker.terminate(); };
      const abort = () => stop('SCAN_CANCELLED');
      const timer = setTimeout(() => stop('ORIGIN_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', value => { if (result !== undefined) stop('ORIGIN_FAILED'); else result = value; });
      worker.on('error', () => { error = failure('ORIGIN_FAILED'); });
      worker.once('exit', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (signal?.aborted) return reject(failure('SCAN_CANCELLED'));
        if (error) return reject(error);
        if (code || !Array.isArray(result) || result.length !== entries.length || result.some(r =>
          !r || !['review', 'background', 'automation', 'user', 'unknown', 'empty'].includes(r.origin) || (r.snapshot &&
            !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => Number.isFinite(r.snapshot[k]))))) {
          return reject(failure('ORIGIN_FAILED'));
        }
        resolve(result);
      });
    });
  }
  return async (root, options = {}) => {
    // Phase 1 is unchanged descriptor-relative metadata traversal, with no rollout reads.
    const catalog = await scanMetadata(root, { ...options, activeOnly: true, deferReviewClassification: true });
    // Phase 2 separately probes bounded session metadata and small initialization-only files, off the UI thread.
    // No catalog is committed until the worker has closed successfully.
    const results = await classify(catalog, options.signal);
    if (options.signal?.aborted) throw failure('SCAN_CANCELLED');
    const nextCache = new Map(), visible = [];
    let hidden = 0, background = 0, automation = 0, empty = 0, unknown = 0, probed = 0;
    catalog.entries.forEach((entry, i) => {
      const result = results[i];
      if (!result.cached) probed++;
      if (result.snapshot) nextCache.set(entry.filePath, { origin: result.origin, cwd: result.cwd || '', snapshot: result.snapshot });
      if (result.origin === 'review') hidden++;
      else if (result.origin === 'background') background++;
      else if (result.origin === 'automation') automation++;
      else if (result.origin === 'empty') empty++;
      else { entry.cwd = result.cwd || ''; visible.push(entry); if (result.origin === 'unknown') unknown++; }
    });
    cacheRoot = catalog.canonicalRoot; cache = nextCache;
    catalog.entries = visible;
    catalog.diagnostics.hiddenReviews = hidden;
    catalog.diagnostics.hiddenBackground = background;
    catalog.diagnostics.hiddenAutomation = automation;
    catalog.diagnostics.originUnknown = unknown;
    catalog.diagnostics.hiddenEmpty = empty;
    catalog.diagnostics.named = visible.filter(e => e.hasTitle).length;
    catalog.originMetrics = { probed, cached: results.length - probed };
    catalog.publicCatalog = toPublicCatalog(catalog);
    return catalog;
  };
}
module.exports = { createBrowsingScanner };
