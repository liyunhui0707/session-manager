'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSessionSourceState } = require('./session-source-state');
const { registerCodexFileIpc } = require('./codex-file-ipc');
const { registerCodexFolderIpc } = require('./codex-folder-ipc');
const { registerCodexPageIpc } = require('./codex-page-ipc');
const { registerConversationImages } = require('./codex-page-images');
const { createConversationReader } = require('./codex-page-reader-v2');
const { registerConversationServices } = require('./codex-page-services');
const { scanCodexSource } = require('./codex-source-catalog');
const { createBrowsingScanner } = require('./codex-page-browsing-scan');
const { createWindowSettings } = require('./session-windows');
const SessionImportIpc = require('./session-import-ipc');
const {
  registerLibraryIpc,
} = require('./session-library-ipc');
const {
  loadSessionLibrary,
} = require('./session-library');

function createWindowContext({ window, ipc, sharedSettings, initial, indexPath, defaultRoot,
  nativeImage, dialog, openWindow, showMenu }) {
  const settings = createWindowSettings(sharedSettings, initial?.settings);
  let libraryIds = new Set(), libraryLoaded = false;
  const sourceState = createSessionSourceState((event) =>
    window && !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(indexPath).href,
  );
  const guardedIpc = sourceState.guard(ipc);
  const pageReader = createConversationReader();
  registerConversationImages(guardedIpc, { reader: pageReader, sourceState, thumbnail: bytes => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('Invalid image');
    const { width, height } = image.getSize();
    const scale = Math.min(1, 800 / width, 600 / height);
    return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toPNG();
  } });
  const scanBrowsingSource = createBrowsingScanner(scanCodexSource);
  const conversationServices = registerConversationServices(guardedIpc, { reader: pageReader, sourceState, scanSource: scanBrowsingSource });
  registerCodexPageIpc(guardedIpc, { reader: pageReader, sourceState });
  registerCodexFileIpc(guardedIpc, { dialog, sourceState,
    loadFile: filePath => pageReader.open({ filePath, canonicalRoot: path.dirname(filePath),
      name: path.basename(filePath), mode: 'codex' }),
  });
  registerCodexFolderIpc(guardedIpc, { dialog, sourceState, settings,
    defaultRoot,
    scanSource: scanBrowsingSource,
    loadEntry: entry => pageReader.open({ ...entry, name: entry.title || entry.sessionId, mode: 'folder' }),
  });
  registerLibraryIpc(guardedIpc, {
    sourceState,
    dialog,
    settings,
    loadLibrary: async root => {
      const result = await loadSessionLibrary(root);
      libraryIds = new Set(result.sessions.map(session => session.id));
      libraryLoaded = true;
      return result;
    },
    releaseSourceReader: () => pageReader.close(),
  });
  SessionImportIpc.register(guardedIpc, {
    canImport: () => sourceState.canImport(),
    getLibraryPath: () => settings.getLibraryPath(),
  });
  const seed = async (target = null) => {
    const saved = await settings.snapshot();
    const root = sourceState.getFolderRoot();
    const file = sourceState.getCodexPath();
    if (root) saved.source = { kind: 'codex', path: root };
    else if (file) saved.source = { kind: 'codex', path: null };
    else if (libraryLoaded) saved.source = { ...saved.source, kind: 'library' };
    return { settings: saved, file, target };
  };
  guardedIpc.handle('sessionWindow:initial', () => ({ ok: true,
    target: initial?.target || null, direct: !!initial?.file }));
  guardedIpc.handle('sessionWindow:new', async () => {
    const initial = await seed();
    if (window.isDestroyed()) return { ok: false, reason: 'cancelled' };
    await openWindow(initial); return { ok: true };
  }, { allowWhileBusy: true });
  guardedIpc.handle('sessionWindow:menu', async (_event, request) => {
    let target;
    if (request.kind === 'folder' && sourceState.getMode() === 'folder') {
      const entry = sourceState.getFolderEntry(request.id);
      if (!entry) return { ok: false, reason: 'stale-entry' };
      target = { kind: 'folder', id: entry.sessionId };
    } else if (request.kind === 'library' && sourceState.getMode() === 'library' && libraryIds.has(request.id)) {
      target = { kind: 'library', id: request.id };
    } else return { ok: false, reason: 'stale-entry' };
    const captured = await seed(target);
    if (!window.isDestroyed()) showMenu(() => { if (!window.isDestroyed()) void openWindow(captured); });
    return { ok: true };
  }, { allowWhileBusy: true, validateArgs: args => args.length === 1 && args[0] &&
    ['folder', 'library'].includes(args[0].kind) && typeof args[0].id === 'string' && args[0].id.length <= 4096 });
  if (initial?.file) sourceState.useCodex(initial.file);
  return {
    seed,
    async dispose() {
      sourceState.cancelFolderScan();
      await Promise.allSettled([pageReader.close(), conversationServices.dispose()]);
    },
  };
}
module.exports = { createWindowContext };
