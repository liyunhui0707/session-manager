'use strict';

// One main-process source and lock for every source-related IPC registration.
function createSessionSourceState(isTrustedSender) {
  let codexPath = null;
  let mode = 'library';
  let generation = 0;
  let folder = null;
  let selectedFolderEntryId = null;
  let scanSequence = 0;
  let activeScan = null;
  let activeJob = null, foregroundWaiting = false;
  function cancelFolderScan() {
    if (!activeScan || activeScan.controller.signal.aborted) return false;
    activeScan.controller.abort();
    return true;
  }
  function clearFolder() {
    cancelFolderScan();
    folder = null;
    selectedFolderEntryId = null;
  }
  function publicCatalog() {
    if (!folder) return null;
    return {
      layout: folder.layout,
      titleIndexState: folder.titleIndexState,
      sourceId: folder.sourceId,
      generation: folder.generation,
      entries: folder.entries.map(({ entryId, sessionId, title, updatedAt, bytes, area, cwd }) =>
        ({ entryId, sessionId, title, updatedAt, bytes, area, cwd })),
      diagnostics: { ...folder.diagnostics },
      selectedEntryId: selectedFolderEntryId,
    };
  }
  return {
    useLibrary() { clearFolder(); codexPath = null; mode = 'library'; generation += 1; },
    useCodex(filePath) { clearFolder(); codexPath = filePath; mode = 'codex'; generation += 1; },
    getCodexPath: () => codexPath,
    getMode: () => mode,
    canImport: () => mode === 'library',
    beginFolderScan(root) {
      const token = { id: ++scanSequence, root, controller: new AbortController() };
      activeScan = token;
      return token;
    },
    finishFolderScan(token) {
      if (activeScan === token) activeScan = null;
    },
    cancelFolderScan,
    commitFolderScan(token, catalog, options = {}) {
      if (activeScan !== token || token.controller.signal.aborted) return false;
      const selectedSessionId = options.preserveSelection && folder && selectedFolderEntryId
        ? folder.byId.get(selectedFolderEntryId)?.sessionId : null;
      generation += 1;
      const entries = catalog.entries.map((entry) => ({ ...entry, generation }));
      folder = {
        ...catalog,
        canonicalRoot: catalog.canonicalRoot,
        generation,
        entries,
        byId: new Map(entries.map((entry) => [entry.entryId, entry])),
      };
      selectedFolderEntryId = selectedSessionId
        ? entries.find((entry) => entry.sessionId === selectedSessionId)?.entryId || null
        : null;
      codexPath = null;
      mode = 'folder';
      return true;
    },
    getFolderRoot: () => folder && folder.canonicalRoot,
    getFolderCatalog: publicCatalog,
    getFolderEntry(entryId) {
      return mode === 'folder' && folder ? folder.byId.get(entryId) || null : null;
    },
    selectFolderEntry(entryId) {
      if (!folder || !folder.byId.has(entryId)) return false;
      selectedFolderEntryId = entryId;
      return true;
    },
    getSelectedFolderEntry() {
      return folder && selectedFolderEntryId ? folder.byId.get(selectedFolderEntryId) || null : null;
    },
    guard(ipc) {
      return {
        handle(channel, handler, policy = {}) {
          ipc.handle(channel, async (event, ...args) => {
            try {
              const validArgs = typeof policy.validateArgs === 'function'
                ? policy.validateArgs(args) : args.length === 0;
              if (!validArgs || !isTrustedSender(event)) {
                return { ok: false, reason: 'invalid-request' };
              }
            } catch { return { ok: false, reason: 'invalid-request' }; }
            if (policy.allowWhileBusy) {
              try { return await handler(event, ...args); }
              catch { return { ok: false, reason: 'operation-failed' }; }
            }
            if (foregroundWaiting) return { ok: false, reason: 'in-progress' };
            if (activeJob) {
              if (!activeJob.interrupt || policy.background) return { ok: false, reason: 'in-progress' };
              // At most one user action waits for a background poll. Retain the
              // lock until its scanner settles; never overlap source mutations.
              foregroundWaiting = true;
              const previous = activeJob;
              try { previous.interrupt(); await previous.done; }
              catch { return { ok: false, reason: 'operation-failed' }; }
              finally { foregroundWaiting = false; }
              try { if (!isTrustedSender(event)) return { ok: false, reason: 'invalid-request' }; }
              catch { return { ok: false, reason: 'invalid-request' }; }
            }
            let release;
            const job = { interrupt: policy.background ? policy.interrupt : null,
              done: new Promise(resolve => { release = resolve; }) };
            activeJob = job;
            try { return await handler(event, ...args); }
            catch { return { ok: false, reason: 'operation-failed' }; }
            finally { if (activeJob === job) activeJob = null; release(); }
          });
        },
      };
    },
  };
}

module.exports = { createSessionSourceState };
