'use strict';

window.addEventListener('DOMContentLoaded', () => {
  const byId = (id) => document.getElementById(id);
  const app = window.SessionApp.createSessionApp({
    document,
    sessionApi: window.sessionApi,
    storage: window.localStorage,
    sessionViewer: window.SessionViewer,
    elements: {
      codexLive: byId('codexLive'),
      openCodexFileButton: byId('openCodexFileButton'),
      openCodexFolderButton: byId('openCodexFolderButton'),
      reloadCodexFileButton: byId('reloadCodexFileButton'),
      reloadCodexFolderButton: byId('reloadCodexFolderButton'),
      rescanCodexFolderButton: byId('rescanCodexFolderButton'),
      cancelCodexFolderScanButton: byId('cancelCodexFolderScanButton'),
      cancelCodexReadButton: byId('cancelCodexReadButton'),
      backToLibraryButton: byId('backToLibraryButton'),
      directDiagnostics: byId('directDiagnostics'),
      librarySearch: byId('librarySearch'),
      folderFilter: byId('folderFilter'),
      folderFilterInput: byId('folderFilterInput'),
      folderSourceNotice: byId('folderSourceNotice'),
      folderDiagnostics: byId('folderDiagnostics'),
      folderPager: byId('folderPager'),
      folderPageStatus: byId('folderPageStatus'),
      folderPrevPageButton: byId('folderPrevPageButton'),
      folderNextPageButton: byId('folderNextPageButton'),
      chooseLibraryButton: byId('chooseLibraryButton'),
      refreshButton: byId('refreshButton'),
      refreshMount: byId('refreshMount'),
      libraryPath: byId('libraryPath'),
      status: byId('status'),
      statusRetry: byId('statusRetry'),
      libraryWarning: byId('libraryWarning'),
      refreshResult: byId('refreshResult'),
      sessionList: byId('sessionList'),
      globalSearchInput: byId('globalSearchInput'),
      globalSearchResults: byId('globalSearchResults'),
      globalSearchBanner: byId('globalSearchBanner'),
      readTitle: byId('readTitle'),
      transcriptPager: byId('transcriptPager'),
      transcriptReadWarning: byId('transcriptReadWarning'),
      transcriptPageStatus: byId('transcriptPageStatus'),
      transcriptPrevious: byId('transcriptPrevious'),
      transcriptNext: byId('transcriptNext'),
      transcriptLatest: byId('transcriptLatest'), transcriptFirst: byId('transcriptFirst'),
      transcriptCancel: byId('transcriptCancel'),
      readMount: byId('readMount'),
      inFileSearchToolbar: byId('inFileSearchToolbar'),
      inFileSearchInput: byId('inFileSearchInput'),
      inFileSearchPrev: byId('inFileSearchPrev'),
      inFileSearchNext: byId('inFileSearchNext'),
      inFileSearchCounter: byId('inFileSearchCounter'),
      largeSessionNotice: byId('largeSessionNotice'),
      loadLargeSessionButton: byId('loadLargeSessionButton'),
      emptyState: byId('emptyState'),
    },
  });
  window.sessionManagerApp = app;
  const live = window.SessionViewer.createCodexLive({ document, app, api: window.sessionApi,
    onOpen() { byId('searchDialog').close(); document.documentElement.dataset.find = 'open'; },
    elements: { root: byId('codexLive'), form: byId('codexSearchForm'), input: byId('codexSearchInput'),
      submit: byId('codexSearchSubmit'), scope: byId('codexSearchScope'), results: byId('codexSearchResults'), status: byId('codexSearchStatus'),
      cancel: byId('codexSearchCancel'), latest: byId('codexNewMessages') } });
  window.codexLive = live;
  const shell = window.SessionViewer.createReaderShell({ document, app, storage: window.localStorage });
  window.readerShell = shell;
  let shellSyncPending = false;
  const shellObserver = new MutationObserver(() => {
    if (shellSyncPending) return;
    shellSyncPending = true;
    queueMicrotask(() => { shellSyncPending = false; shell.sync(); });
  });
  for (const id of ['readTitle', 'status', 'sessionList', 'libraryPath', 'transcriptPager', 'inFileSearchToolbar']) {
    shellObserver.observe(byId(id), { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  }
  const poll = setInterval(() => { if (!document.hidden) void live.tick(); }, 5000);
  window.addEventListener('focus', () => { void live.tick(); });
  window.addEventListener('beforeunload', () => { clearInterval(poll); shellObserver.disconnect(); live.dispose(); });
  byId('newWindowButton').addEventListener('click', () => { void window.sessionApi.newWindow(); });
  function sessionMenu(event) {
    const row = event.target.closest?.('.session-row');
    if (!row) return;
    event.preventDefault();
    const entry = row.getAttribute('data-entry-id');
    const id = entry || row.getAttribute('data-note-id');
    if (id) void window.sessionApi.showSessionMenu({ kind: entry ? 'folder' : 'library', id });
  }
  byId('sessionList').addEventListener('contextmenu', sessionMenu);
  byId('sessionList').addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) sessionMenu(event);
  });
  window.addEventListener('storage', event => {
    if (!event.key || event.key === 'aiSessionManager.readerAppearance') shell.refreshPreferences();
    if (!event.key || event.key === 'aiSessionManager.favorites' || event.key.startsWith('aiSessionManager.codexSourceFavorites.')) {
      app.refreshSharedState(); shell.sync();
    }
  });
  void window.sessionApi.getWindowInitial().then(initial => app.initializeWindow(initial));
});
