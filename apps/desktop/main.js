'use strict';

const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, nativeImage, Menu } = require('electron');
const { createLibrarySettings } = require('./lib/session-library-settings');
const { createWindowRouter } = require('./lib/session-windows');
const { createWindowContext } = require('./lib/session-window-context');

const contexts = new Map();
const router = createWindowRouter(ipcMain);
let sharedSettings;
let quitting = false;

function createWindow(initial) {
  if (quitting) return;
  const window = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'AI Session Manager', show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js') },
  });
  const sender = window.webContents;
  const context = createWindowContext({ window, ipc: router.attach(sender), sharedSettings, initial,
    indexPath: path.join(__dirname, 'index.html'), defaultRoot: path.join(app.getPath('home'), '.codex'),
    nativeImage, dialog: { async showOpenDialog(options) {
      const result = await dialog.showOpenDialog(window, options);
      if (window.isDestroyed()) return { canceled: true, filePaths: [] };
      return result;
    } },
    openWindow: createWindow,
    showMenu: click => Menu.buildFromTemplate([{ label: '在新窗口打开', click }]).popup({ window }),
  });
  contexts.set(window, context);
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  sender.setWindowOpenHandler(() => ({ action: 'deny' }));
  sender.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => {
    router.detach(sender); contexts.delete(window); void context.dispose();
  });
  void window.loadFile(path.join(__dirname, 'index.html'));
}

async function newWindow() {
  const context = contexts.get(BrowserWindow.getFocusedWindow());
  createWindow(context ? await context.seed() : undefined);
}

app.whenReady().then(() => {
  sharedSettings = createLibrarySettings({ settingsPath: path.join(app.getPath('userData'), 'session-library.json') });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [
      { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => { void newWindow(); } },
      { type: 'separator' }, { role: 'close', label: '关闭窗口' },
    ] },
    { role: 'editMenu' },
    { label: '显示', submenu: [{ role: 'togglefullscreen', label: '进入／退出全屏' }] },
    { role: 'windowMenu', label: '窗口' },
  ]));
  createWindow();
  app.on('activate', () => { if (contexts.size === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  quitting = true;
  for (const context of contexts.values()) void context.dispose();
});
