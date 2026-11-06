'use strict';

const { scanCodexSource } = require('./codex-source-catalog');
const { loadCodexCatalogEntry } = require('./codex-file');
const { pageFailure } = require('./codex-page-ipc');

const CHANNELS = Object.freeze({
  CHOOSE: 'codexFolder:choose',
  RESTORE: 'codexFolder:restore',
  RESCAN: 'codexFolder:rescan',
  CANCEL: 'codexFolder:cancel',
  LOAD: 'codexFolder:load',
  RELOAD: 'codexFolder:reload',
});
const OPAQUE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function scanFailure(error) {
  if (error && error.code === 'SCAN_CANCELLED') return { ok: false, reason: 'cancelled' };
  if (error && error.code === 'PLATFORM_UNSUPPORTED') return { ok: false, reason: 'platform-unsupported' };
  if (error && typeof error.message === 'string' && error.message.startsWith('symlink-safe reads unsupported on this platform')) {
    return { ok: false, reason: 'platform-unsupported' };
  }
  return { ok: false, reason: 'invalid-source' };
}

function loadFailure(error) {
  if (error && ['DECOMPRESSION_FAILED', 'DECOMPRESSION_LIMIT', 'SOURCE_CHANGED', 'RECORD_TOO_LARGE', 'MESSAGE_TOO_LARGE', 'PLATFORM_UNSUPPORTED', 'READ_CANCELLED', 'READ_TIMEOUT'].includes(error.code)) return pageFailure(error);
  if (error && error.code === 'OVER_CAP') return { ok: false, reason: 'over-cap' };
  if (error && typeof error.message === 'string' && error.message.startsWith('symlink-safe reads unsupported on this platform')) {
    return { ok: false, reason: 'platform-unsupported' };
  }
  return { ok: false, reason: 'invalid-file' };
}

function registerCodexFolderIpc(ipc, options) {
  const { dialog, sourceState } = options;
  async function scan(root, scanOptions = {}) {
    const token = sourceState.beginFolderScan(root);
    try {
      const catalog = await options.scanSource?.(root, { signal: token.controller.signal }) ||
        await scanCodexSource(root, { signal: token.controller.signal });
      if (!sourceState.commitFolderScan(token, catalog, scanOptions)) return { ok: false, reason: 'stale-result' };
      return { ok: true, catalog: sourceState.getFolderCatalog() };
    } catch (error) { return scanFailure(error); }
    finally { sourceState.finishFolderScan(token); }
  }

  ipc.handle(CHANNELS.CHOOSE, async () => {
    let result;
    try {
      result = await dialog.showOpenDialog({ title: '选择 Codex 文件夹',
        message: 'Select the folder containing sessions and session_index.jsonl for active sessions and saved names. Archived sessions are hidden. Selecting sessions alone cannot load the parent name index.',
        properties: ['openDirectory'] });
    } catch (error) { return scanFailure(error); }
    const root = result && result.filePaths && result.filePaths[0];
    if (!result || result.canceled || !root) return { ok: false, reason: 'cancelled' };
    const loaded = await scan(root);
    if (loaded.ok) {
      try { await options.settings?.setCodexPath(root); }
      catch { loaded.preferenceWarning = true; }
    }
    return loaded;
  });

  ipc.handle(CHANNELS.RESTORE, async () => {
    const saved = await options.settings?.getSource?.();
    if (saved?.kind === 'library') return { ok: false, reason: 'library-selected' };
    const roots = [...new Set([saved?.path, options.defaultRoot].filter(Boolean))];
    for (const root of roots) {
      const result = await scan(root);
      if (result.ok || result.reason === 'cancelled') return result;
    }
    return { ok: false, reason: 'no-source' };
  });

  ipc.handle(CHANNELS.RESCAN, async () => {
    const root = sourceState.getFolderRoot();
    if (!root) return { ok: false, reason: 'no-source' };
    return scan(root, { preserveSelection: true });
  });

  ipc.handle(CHANNELS.LOAD, async (_event, entryId) => {
    const entry = sourceState.getFolderEntry(entryId);
    if (!entry) return { ok: false, reason: 'unknown-entry' };
    try {
      const session = await (options.loadEntry || loadCodexCatalogEntry)(entry);
      if (!sourceState.selectFolderEntry(entryId)) return { ok: false, reason: 'stale-result' };
      return { ok: true, generation: entry.generation, entryId, session };
    } catch (error) { return loadFailure(error); }
  }, { validateArgs: (args) => args.length === 1 && OPAQUE_ID_RE.test(args[0]) });

  ipc.handle(CHANNELS.RELOAD, async () => {
    const entry = sourceState.getSelectedFolderEntry();
    if (!entry) return { ok: false, reason: 'no-source' };
    try {
      const session = await (options.loadEntry || loadCodexCatalogEntry)(entry);
      return { ok: true, generation: entry.generation, entryId: entry.entryId, session };
    } catch (error) { return loadFailure(error); }
  });

  ipc.handle(CHANNELS.CANCEL, async () => sourceState.cancelFolderScan()
    ? { ok: true } : { ok: false, reason: 'no-scan' }, { allowWhileBusy: true });
}

module.exports = { CHANNELS, registerCodexFolderIpc };
