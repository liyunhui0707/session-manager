'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sessionApi', {
  readCodexImage: request => ipcRenderer.invoke('codexImage:read', request),
  syncCodexConversation: () => ipcRenderer.invoke('codexConversation:sync'),
  moreCodexSearch: token => ipcRenderer.invoke('codexConversation:search-more', token),
  searchCodexConversations: (query, scope) => ipcRenderer.invoke('codexConversation:search', query, scope),
  openCodexSearchHit: hitId => ipcRenderer.invoke('codexConversation:open-hit', hitId),
  cancelCodexSearch: () => ipcRenderer.invoke('codexConversation:cancel-search'),
  codexSearchProgress: () => ipcRenderer.invoke('codexConversation:search-progress'),
  moveCodexPage: (readerId, direction) => ipcRenderer.invoke('codexPage:move', readerId, direction),
  cancelCodexPage: () => ipcRenderer.invoke('codexPage:cancel'),
  chooseCodexFile: () => ipcRenderer.invoke('codexFile:choose'),
  reloadCodexFile: () => ipcRenderer.invoke('codexFile:reload'),
  restoreCodexFolder: () => ipcRenderer.invoke('codexFolder:restore'),
  chooseCodexFolder: () => ipcRenderer.invoke('codexFolder:choose'),
  rescanCodexFolder: () => ipcRenderer.invoke('codexFolder:rescan'),
  cancelCodexFolderScan: () => ipcRenderer.invoke('codexFolder:cancel'),
  loadCodexCatalogEntry: (entryId) => ipcRenderer.invoke('codexFolder:load', entryId),
  reloadCodexCatalogEntry: () => ipcRenderer.invoke('codexFolder:reload'),
  getSelectedLibrary: () =>
    ipcRenderer.invoke('sessionLibrary:get-selected'),
  chooseLibrary: () =>
    ipcRenderer.invoke('sessionLibrary:choose'),
  loadSessions: () =>
    ipcRenderer.invoke('sessionLibrary:load'),
  refreshSessions: () =>
    ipcRenderer.invoke('sessionViewer:import'),
});
