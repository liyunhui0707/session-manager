'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { createConversationReader } = require('./codex-page-reader-v2');
const { pageFailure } = require('./codex-page-ipc');
const UUID = /^[0-9a-f-]{36}$/i;
function registerConversationServices(ipc, { sourceState, reader, scanSource, searchReader = createConversationReader() }) {
  let hits = new Map(), searching = false, cancelled = false, disposed = false, searchState = null;
  async function cancel() { cancelled = true; if (searching) await searchReader.cancel(); }
  let progress = { searched: 0, total: 0, failed: 0 };
  ipc.handle('codexConversation:search-progress', async () => ({ ok: true, searching, ...progress }), { allowWhileBusy: true });
  const fingerprint = c => JSON.stringify({ sourceId: c.sourceId, layout: c.layout, titleIndexState: c.titleIndexState,
    diagnostics: c.diagnostics, entries: c.entries.map(({ sessionId, title, bytes, updatedAt, area }) => ({ sessionId, title, bytes, updatedAt, area })) });
  ipc.handle('codexConversation:sync', async () => {
    if (sourceState.getMode() === 'codex') {
      const source = reader.getSource(), snapshot = reader.getSnapshot?.();
      if (!source || !snapshot) return { ok: true, changed: false };
      try {
        const stat = await fs.lstat(source.filePath);
        return { ok: true, changed: false, bodyChanged: stat.isSymbolicLink() ||
          Object.keys(snapshot).some(key => stat[key] !== snapshot[key]) };
      } catch { return { ok: false, reason: 'unavailable' }; }
    }
    const previous = sourceState.getFolderCatalog(), root = sourceState.getFolderRoot();
    if (!root || !previous) return { ok: true, changed: false };
    const selected = sourceState.getSelectedFolderEntry();
    const token = sourceState.beginFolderScan(root);
    try {
      const next = await scanSource(root, { signal: token.controller.signal, activeOnly: true });
      if (token.controller.signal.aborted) return { ok: false, reason: 'cancelled' };
      if (fingerprint(previous) === fingerprint(next)) return { ok: true, changed: false };
      if (!sourceState.commitFolderScan(token, next, { preserveSelection: true })) return { ok: false, reason: 'stale-result' };
      hits.clear();
      const entry = sourceState.getSelectedFolderEntry();
      if (entry) reader.rebind({ ...entry, name: entry.title, mode: 'folder' });
      else if (selected) await reader.close?.();
      return { ok: true, changed: true, catalog: sourceState.getFolderCatalog(),
        bodyChanged: !!(entry && selected && (entry.bytes !== selected.bytes || entry.updatedAt !== selected.updatedAt || entry.filePath !== selected.filePath)) };
    } catch { return { ok: false, reason: token.controller.signal.aborted ? 'cancelled' : 'scan-failed' }; }
    finally { sourceState.finishFolderScan(token); }
  }, { background: true, interrupt: () => sourceState.cancelFolderScan() });
  async function searchPage(state) {
    hits.clear(); cancelled = false; searching = true;
    const results = [];
    progress = { searched: Math.min(state.entries.length, state.index + (state.offset > 0 ? 1 : 0)), total: state.entries.length, failed: state.failed };
    try {
      while (state.index < state.entries.length && results.length < 200 && !cancelled) {
        const entry = state.entries[state.index];
        try {
          const result = await searchReader.search({ ...entry, ...(state.snapshot ? { snapshot: state.snapshot } : {}) },
            state.query, { offset: state.offset, limit: 200 - results.length });
          if (cancelled || disposed) break;
          if (result.incomplete && !state.offset) state.partial++;
          for (const match of result.matches) {
            const hitId = randomUUID();
            hits.set(hitId, { source: entry, page: match.page, query: state.query, mode: state.mode,
              generation: state.generation, message: match.message, snapshot: result.snapshot });
            results.push({ hitId, title: entry.title || entry.name || entry.sessionId, snippet: match.snippet });
          }
          if (result.moreMatches && result.matches.length) {
            state.offset += result.matches.length; state.snapshot = result.snapshot;
          } else { state.index++; state.offset = 0; state.snapshot = null; }
        } catch (error) {
          if (error.code === 'SOURCE_CHANGED') { searchState = null; hits.clear(); return { ok: false, reason: 'stale-result' }; }
          if (!cancelled) { state.failed++; state.index++; state.offset = 0; state.snapshot = null; }
        }
        progress = { searched: Math.min(state.entries.length, state.index + (state.offset > 0 ? 1 : 0)), total: state.entries.length, failed: state.failed };
      }
      state.shown += results.length;
      const more = !cancelled && state.index < state.entries.length;
      state.token = more ? randomUUID() : null;
      return { ok: true, hits: results, ...progress, cancelled, partialConversations: state.partial,
        complete: !cancelled && !more && !state.failed && !state.partial,
        truncated: false, nextToken: state.token, shown: state.shown, hasMore: more };
    } finally { searching = false; }
  }
  ipc.handle('codexConversation:search', async (_event, query, scope) => {
    if (disposed) return { ok: false, reason: 'unavailable' };
    const catalog = sourceState.getFolderCatalog(), mode = sourceState.getMode(), source = reader.getSource();
    const entries = scope === 'all' && mode === 'folder'
      ? catalog.entries.filter(e => e.area === 'active').map(e => sourceState.getFolderEntry(e.entryId)).filter(Boolean)
      : source ? [source] : [];
    searchState = { entries, query, mode, generation: catalog?.generation, path: sourceState.getCodexPath(),
      index: 0, offset: 0, snapshot: null, failed: 0, partial: 0, shown: 0 };
    return searchPage(searchState);
  }, { validateArgs: args => args.length === 2 && typeof args[0] === 'string' && args[0].trim().length > 0 &&
    args[0].length <= 256 && ['all', 'current'].includes(args[1]) });
  ipc.handle('codexConversation:search-more', async (_event, token) => {
    const state = searchState;
    if (disposed || !state || state.token !== token || state.mode !== sourceState.getMode() ||
        (state.mode === 'folder' && state.generation !== sourceState.getFolderCatalog()?.generation) ||
        (state.mode === 'codex' && state.path !== sourceState.getCodexPath())) return { ok: false, reason: 'stale-result' };
    state.token = null;
    return searchPage(state);
  }, { validateArgs: args => args.length === 1 && typeof args[0] === 'string' && UUID.test(args[0]) });
  ipc.handle('codexConversation:open-hit', async (_event, hitId) => {
    const hit = hits.get(hitId), catalog = sourceState.getFolderCatalog();
    if (!hit || hit.mode !== sourceState.getMode() || (hit.mode === 'folder' && catalog?.generation !== hit.generation) ||
        (hit.mode === 'codex' && hit.source.filePath !== sourceState.getCodexPath())) return { ok: false, reason: 'stale-result' };
    try {
      const source = hit.mode === 'folder' ? sourceState.getFolderEntry(hit.source.entryId) : hit.source;
      if (!source) return { ok: false, reason: 'stale-result' };
      const session = await reader.open({ ...source, snapshot: hit.snapshot, mode: hit.mode, name: source.title || source.name }, { page: hit.page });
      if (hit.mode === 'folder') sourceState.selectFolderEntry(source.entryId);
      return { ok: true, session, entryId: source.entryId, query: hit.query, message: hit.message };
    } catch (error) { return pageFailure(error); }
  }, { validateArgs: args => args.length === 1 && typeof args[0] === 'string' && UUID.test(args[0]) });
  ipc.handle('codexConversation:cancel-search', async () => {
    await cancel(); return { ok: true };
  }, { allowWhileBusy: true });
  return { cancel, async dispose() { disposed = true; hits.clear(); searchState = null; await cancel(); await searchReader.close?.(); } };
}
module.exports = { registerConversationServices };
