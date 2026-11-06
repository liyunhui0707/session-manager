'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSessionSourceState } = require('./lib/session-source-state');
const { registerCodexFileIpc } = require('./lib/codex-file-ipc');
const { registerCodexFolderIpc } = require('./lib/codex-folder-ipc');
const { registerCodexPageIpc } = require('./lib/codex-page-ipc');
const { registerConversationImages } = require('./lib/codex-page-images');
const { createConversationReader } = require('./lib/codex-page-reader-v2');
const { registerConversationServices } = require('./lib/codex-page-services');
const { scanCodexSource } = require('./lib/codex-source-catalog');
const { createBrowsingScanner } = require('./lib/codex-page-browsing-scan');
const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');
const SessionImportIpc = require('./lib/session-import-ipc');
const {
  registerLibraryIpc,
} = require('./lib/session-library-ipc');
const {
  createLibrarySettings,
} = require('./lib/session-library-settings');
const {
  loadSessionLibrary,
} = require('./lib/session-library');

let mainWindow = null;
let pageReader = null;
let conversationServices = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'AI Session Manager',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    if (pageReader) void pageReader.cancel();
    if (conversationServices) void conversationServices.cancel();
    mainWindow = null;
  });
}

function registerServices() {
  const settings = createLibrarySettings({
    settingsPath: path.join(app.getPath('userData'), 'session-library.json'),
  });
  const sourceState = createSessionSourceState((event) =>
    mainWindow && !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(path.join(__dirname, 'index.html')).href,
  );
  const guardedIpc = sourceState.guard(ipcMain);
  pageReader = createConversationReader();
  registerConversationImages(guardedIpc, { reader: pageReader, sourceState, thumbnail: bytes => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('Invalid image');
    const { width, height } = image.getSize();
    const scale = Math.min(1, 800 / width, 600 / height);
    return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toPNG();
  } });
  const scanBrowsingSource = createBrowsingScanner(scanCodexSource);
  conversationServices = registerConversationServices(guardedIpc, { reader: pageReader, sourceState, scanSource: scanBrowsingSource });
  registerCodexPageIpc(guardedIpc, { reader: pageReader, sourceState });
  registerCodexFileIpc(guardedIpc, { dialog, sourceState,
    loadFile: filePath => pageReader.open({ filePath, canonicalRoot: path.dirname(filePath),
      name: path.basename(filePath), mode: 'codex' }),
  });
  registerCodexFolderIpc(guardedIpc, { dialog, sourceState, settings,
    defaultRoot: path.join(app.getPath('home'), '.codex'),
    scanSource: scanBrowsingSource,
    loadEntry: entry => pageReader.open({ ...entry, name: entry.title || entry.sessionId, mode: 'folder' }),
  });
  registerLibraryIpc(guardedIpc, {
    sourceState,
    dialog,
    settings,
    loadLibrary: loadSessionLibrary,
    releaseSourceReader: () => pageReader.close(),
  });
  SessionImportIpc.register(guardedIpc, {
    canImport: () => sourceState.canImport(),
    getLibraryPath: () => settings.getLibraryPath(),
  });
}

app.whenReady().then(() => {
  registerServices();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { if (conversationServices) void conversationServices.dispose(); });
