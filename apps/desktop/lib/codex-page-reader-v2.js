'use strict';
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createSearchCache } = require('./codex-page-search-cache');
const { findSeek } = require('./codex-page-seek');
const failure = code => Object.assign(new Error(code), { code });
function createConversationReader() {
  let current = null, active = null;
  const stats = { scans: 0, validations: 0 };
  function run(source, options = {}) {
    if (active) return Promise.reject(failure('READ_BUSY'));
    stats[options.validateOnly ? 'validations' : 'scans']++;
    const worker = new Worker(path.join(__dirname, 'codex-page-reader-task.js'), {
      workerData: { source, ...options }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    const job = { worker, cancelled: false, error: null, result: null };
    active = job;
    const timer = setTimeout(() => { job.error = failure('READ_TIMEOUT'); void worker.terminate(); }, 30000);
    job.completion = new Promise((resolve, reject) => {
      worker.on('message', result => { job.result = result; });
      worker.on('error', () => { job.error = failure('READ_FAILED'); });
      worker.once('exit', code => {
        clearTimeout(timer); if (active === job) active = null;
        if (job.cancelled) reject(failure('READ_CANCELLED'));
        else if (job.error) reject(job.error);
        else if (code || !job.result) reject(failure('READ_FAILED'));
        else if (!job.result.ok) reject(failure(job.result.code));
        else resolve(job.result.result);
      });
    });
    return job.completion;
  }
  const searches = createSearchCache(run);
  function reuseLatest(source, state) {
    if (!state || state.source.filePath !== source.filePath || state.source.canonicalRoot !== source.canonicalRoot) return null;
    const result = state.result, page = result.pages - 1;
    if (source.snapshot && JSON.stringify(source.snapshot) !== JSON.stringify(result.snapshot)) return null;
    const messages = result.number === page ? result.conversation.messages : result.window?.find(p => p.number === page)?.messages;
    if (!messages) return null;
    return (async () => {
      try { await run({ ...source, snapshot: result.snapshot }, { validateOnly: true }); }
      catch (error) { if (error.code === 'SOURCE_CHANGED' && !source.snapshot) return null; throw error; }
      if (state !== current) throw failure('STALE_READER');
      return { ...result, number: page, conversation: { ...result.conversation, messages },
        work: { incremental: false, parsedRecords: 0, verifiedPrefixBytes: 0, reused: true } };
    })();
  }
  function seekOptions(result, page) {
    const point = findSeek(result?.index, page) || (result?.index ? { offset: 0, records: 0, state: {} } : null);
    return point ? { point, index: result.index, summary: { pages: result.pages, count: result.count,
      waiting: result.waiting, ambiguous: result.ambiguous, incomplete: result.incomplete, diagnostics: result.conversation.diagnostics } } : null;
  }
  function publish(state, result, latest) {
    return { name: state.source.name, cwd: state.source.cwd || '', sourceBytes: result.snapshot.size, conversation: result.conversation,
      page: { readerId: state.id, number: result.number + 1, hasPrevious: result.number > 0,
        hasNext: result.number + 1 < result.pages, pages: result.pages, latest,
        conversationOnly: true, waiting: result.waiting, ambiguous: result.ambiguous,
        compressed: state.source.filePath.endsWith('.zst'), scannedBytes: result.snapshot.size, totalBytes: result.snapshot.size } };
  }
  return {
    async open(source, options = {}) {
      const pendingReuse = options.page === undefined ? reuseLatest(source, current) : null;
      const reused = pendingReuse ? await pendingReuse : null;
      if (reused) {
        current = { id: randomUUID(), source: { ...source }, result: reused };
        return publish(current, reused, true);
      }
      const append = options.page === undefined && !source.snapshot && current?.source.filePath === source.filePath &&
        current.source.canonicalRoot === source.canonicalRoot ? current.result.append : null;
      const sameSource = current?.source.filePath === source.filePath && current?.source.canonicalRoot === source.canonicalRoot;
      let seek = sameSource && options.page !== undefined ? seekOptions(current.result, options.page) : null;
      // A caller-supplied snapshot must also match the index's complete snapshot.
      if (source.snapshot && JSON.stringify(source.snapshot) !== JSON.stringify(current?.result.snapshot)) seek = null;
      let result;
      try { result = await run(seek ? { ...source, snapshot: current.result.snapshot } : source,
        { append, index: sameSource ? current.result.index : null, seek, ...options }); }
      catch (error) {
        if (!seek || source.snapshot || error.code !== 'SOURCE_CHANGED') throw error;
        result = await run(source, options);
      }
      current = { id: randomUUID(), source: { ...source }, result };
      return publish(current, result, options.page === undefined);
    },
    async move(id, direction) {
      if (!current || current.id !== id) throw failure('STALE_READER');
      if (!['next', 'previous', 'latest', 'first'].includes(direction)) throw failure('INVALID_REQUEST');
      const state = current;
      const page = direction === 'latest' ? undefined : direction === 'first' ? 0 : state.result.number + (direction === 'next' ? 1 : -1);
      if (page !== undefined && (page < 0 || page >= state.result.pages)) throw failure('PAGE_UNAVAILABLE');
      const source = { ...state.source, snapshot: direction === 'latest' ? undefined : state.result.snapshot };
      const cached = page === undefined ? null : state.result.window?.find(entry => entry.number === page);
      const pendingReuse = direction === 'latest' ? reuseLatest(source, state) : null;
      let result = pendingReuse ? await pendingReuse : null;
      if (result) { /* validated latest snapshot is already retained */ }
      else if (cached) {
        await run(source, { validateOnly: true });
        result = { ...state.result, number: page,
          conversation: { ...state.result.conversation, messages: cached.messages } };
      } else result = await run(source, { page, index: state.result.index, seek: page === undefined ? null : seekOptions(state.result, page), append: direction === 'latest' ? state.result.append : null });
      if (state !== current) throw failure('STALE_READER');
      state.result = result; return publish(state, result, direction === 'latest');
    },
    search: (source, query, options) => searches.search(source, query, options),
    getSource: () => current?.source || null,
    getSnapshot: () => current?.result.snapshot || null,
    // Internal performance evidence only; not exposed over renderer IPC.
    getReadStats: () => ({ ...stats }),
    getCacheUsage: () => ({ seekPoints: current?.result.index?.points.length || 0, seekBytes: current?.result.index?.bytes || 0, ...searches.usage() }),
    getReadWork: () => current?.result.work ? { ...current.result.work } : null,
    getImageReference(request) {
      if (!current || current.id !== request.readerId || current.result.number + 1 !== request.page) return null;
      const message = current.result.conversation.messages[request.message];
      if (!message) return null;
      const { describeMessage } = require('./session-viewer/conversation-presentation');
      const image = describeMessage(message.text, message.role, true)?.images?.[request.image];
      return image ? { path: image.path, source: current.source } : null;
    },
    rebind(source) { if (current && current.source.filePath === source.filePath) current.source = { ...current.source, ...source }; },
    async cancel() {
      if (!active) return false;
      const job = active; job.cancelled = true; await job.worker.terminate();
      await job.completion.catch(() => {}); return true;
    },
    async close() { await this.cancel(); current = null; searches.clear(); },
  };
}
module.exports = { createConversationReader };
