'use strict';

(function () {

const { formatRefreshResult } = typeof require !== 'undefined'
  ? require('./session-viewer/refresh-result') : window.SessionViewer;

const { createDirectSessionView } = typeof require !== 'undefined'
  ? require('./session-viewer/direct-session') : window.SessionViewer;

const { createCodexFolderView } = typeof require !== 'undefined'
  ? require('./session-viewer/codex-folder-view') : window.SessionViewer;

const { createOperationStatus } = typeof require !== 'undefined'
  ? require('./session-viewer/operation-status') : window.SessionViewer;

const GROUP_COLLAPSE_KEY = 'aiSessionManager.groups.collapsed';
const BUCKET_COLLAPSE_KEY = 'aiSessionManager.buckets.collapsed';

function readSet(storage, key) {
  try {
    const parsed = JSON.parse(storage && storage.getItem(key));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeSet(storage, key, values) {
  try {
    if (storage) storage.setItem(key, JSON.stringify([...values]));
  } catch {}
}

function clearNode(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function createSessionApp(options) {
  const elements = options && options.elements;
  const doc = options && options.document;
  const sessionApi = options && options.sessionApi;
  const storage = options && options.storage;
  const viewer = options && options.sessionViewer;
  if (!elements || !doc || !sessionApi || !viewer) {
    throw new Error('session-app: elements, document, sessionApi, and sessionViewer are required');
  }

  let sessions = [];
  let listFilter = { agent: 'all', query: '', favoritesOnly: false };
  let selectedId = null;
  let pendingSearchQuery = '';
  let libraryPath = null;
  let indexState = { globalIndexStatus: 'idle', globalIndex: null };
  let indexPromise = null;
  let libraryGeneration = 0;
  let searchToken = 0;
  let refreshInFlight = false;
  let sourceBusy = false;
  let sourceMode = 'library';
  const collapsedGroups = readSet(storage, GROUP_COLLAPSE_KEY);
  const collapsedBuckets = readSet(storage, BUCKET_COLLAPSE_KEY);
  const favorites = viewer.createFavoritesController({ storage });

  const inFileSearch = viewer.createInFileSearchToolbar({
    toolbarRoot: elements.inFileSearchToolbar,
    searchInput: elements.inFileSearchInput,
    prevButton: elements.inFileSearchPrev,
    nextButton: elements.inFileSearchNext,
    counterEl: elements.inFileSearchCounter,
    readMount: elements.readMount,
    document: doc,
    searchDom: viewer,
    revealMatch: (match) => directView.revealMatch(match),
  });

  const operation = createOperationStatus(elements.status, elements.statusRetry, elements.readMount);
  const directView = createDirectSessionView({ elements, viewer, inFileSearch, document: doc, sessionApi,
    onBusy(value) { sourceBusy = value; syncSourceControls(); }, onStatus: setStatus, onReload: () => sourceMode === 'folder' ? folderView.reload() : reloadCodexFile(),
  });

  const hasFolderUi = elements.folderFilter && elements.folderFilterInput &&
    elements.folderDiagnostics && elements.folderPageStatus &&
    elements.folderPrevPageButton && elements.folderNextPageButton;
  const folderView = hasFolderUi ? createCodexFolderView({
    document: doc,
    elements,
    sessionApi,
    storage,
    createFavoritesController: viewer.createFavoritesController,
    directView,
    onActivate: activateFolder,
    onStatus: setStatus,
    onStateChange: syncSourceControls,
  }) : {
    choose: async () => false, rescan: async () => false, cancel: async () => false,
    openEntry: async () => false, reload: async () => false, clear() {},
    isActive: () => false, isBusy: () => false,
    getState: () => ({ scanning: false, loading: false, selectedEntryId: null }),
  };

  const groupedRenderer = viewer.createGroupedListRenderer({
    container: elements.sessionList,
    document: doc,
    favoritesController: favorites,
    onRowClick: (id) => selectSession(id),
    onStarClick: (relativePath) => toggleFavorite(relativePath),
    onHeaderToggle: (groupKey) => {
      if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
      else collapsedGroups.add(groupKey);
      writeSet(storage, GROUP_COLLAPSE_KEY, collapsedGroups);
      renderTree();
    },
    isCollapsed: (groupKey) => collapsedGroups.has(groupKey),
    onBucketToggle: (groupKey, layerId) => {
      const key = `${groupKey}:${layerId}`;
      if (collapsedBuckets.has(key)) collapsedBuckets.delete(key);
      else collapsedBuckets.add(key);
      writeSet(storage, BUCKET_COLLAPSE_KEY, collapsedBuckets);
      renderTree();
    },
    isBucketCollapsed: (groupKey, layerId) =>
      collapsedBuckets.has(`${groupKey}:${layerId}`),
  });

  function setStatus(message, isError, retry) { operation.set(message, isError, retry); }

  function syncRefreshButton() {
    if (elements.refreshButton) {
      elements.refreshButton.disabled = refreshInFlight || sourceBusy || folderView.isBusy() || sourceMode !== 'library' || !libraryPath;
    }
  }

  function syncSourceControls() {
    syncRefreshButton();
    const direct = sourceMode === 'codex';
    const folder = sourceMode === 'folder';
    if (elements.codexLive) elements.codexLive.hidden = !direct && !folder;
    const folderState = folderView.getState();
    const busy = sourceBusy || refreshInFlight || folderView.isBusy();
    operation.busy(busy);
    for (const name of ['chooseLibraryButton', 'openCodexFileButton', 'openCodexFolderButton', 'reloadCodexFileButton', 'reloadCodexFolderButton', 'rescanCodexFolderButton', 'backToLibraryButton']) {
      if (elements[name]) elements[name].disabled = busy;
    }
    if (elements.reloadCodexFileButton) elements.reloadCodexFileButton.hidden = !direct;
    if (elements.cancelCodexReadButton) elements.cancelCodexReadButton.hidden = !(sourceBusy || folderState.loading) || directView.isBusy();
    if (elements.reloadCodexFolderButton) elements.reloadCodexFolderButton.hidden = !folder || !folderState.selectedEntryId;
    if (elements.rescanCodexFolderButton) elements.rescanCodexFolderButton.hidden = !folder;
    if (elements.cancelCodexFolderScanButton) {
      elements.cancelCodexFolderScanButton.hidden = !folderState.scanning;
      elements.cancelCodexFolderScanButton.disabled = !folderState.scanning;
    }
    if (elements.backToLibraryButton) elements.backToLibraryButton.hidden = sourceMode === 'library';
    if (elements.librarySearch) elements.librarySearch.hidden = sourceMode !== 'library';
    if (elements.folderFilter) elements.folderFilter.hidden = !folder;
    if (elements.folderPager) elements.folderPager.hidden = !folder;
    elements.sessionList.hidden = direct;
  }

  function renderTree() {
    const query = listFilter.query.toLocaleLowerCase();
    const visible = sessions.filter(item => (listFilter.agent === 'all' || item.agent === listFilter.agent) &&
      (!listFilter.favoritesOnly || favorites.isFavorite(item.relativePath)) &&
      (!query || (item.title || '').toLocaleLowerCase().includes(query) || String(item.id).toLocaleLowerCase().includes(query)));
    const tree = viewer.groupAndSort(visible, {
      isFavorite: (item) => favorites.isFavorite(item.relativePath),
    });
    groupedRenderer.render(tree, selectedId);
    elements.emptyState.hidden = visible.length > 0;
    elements.emptyState.textContent = sessions.length ? '没有符合筛选条件的会话。' : '选择本地来源，开始回看对话。';
  }

  function replaceSessions(nextSessions, nextLibraryPath) {
    folderView.clear();
    directView.clear();
    sourceMode = 'library';
    sessions = Array.isArray(nextSessions) ? nextSessions : [];
    libraryPath = nextLibraryPath || null;
    selectedId = null;
    pendingSearchQuery = '';
    indexState = { globalIndexStatus: 'idle', globalIndex: null };
    indexPromise = null;
    libraryGeneration += 1;
    searchToken += 1;
    clearNode(elements.globalSearchResults);
    elements.globalSearchInput.value = '';
    elements.globalSearchBanner.hidden = true;
    elements.largeSessionNotice.hidden = true;
    elements.libraryWarning.hidden = true;
    elements.libraryWarning.textContent = '';
    elements.refreshResult.hidden = true;
    elements.refreshResult.textContent = '';
    inFileSearch.onReadDeactivated();
    elements.libraryPath.textContent = libraryPath || '尚未选择来源';
    elements.readTitle.textContent = '';
    clearNode(elements.readMount);
    renderTree();
    syncSourceControls();
  }

  function activateFolder() {
    directView.clear();
    sessions = [];
    libraryPath = null;
    selectedId = null;
    pendingSearchQuery = '';
    indexState = { globalIndexStatus: 'idle', globalIndex: null };
    indexPromise = null;
    libraryGeneration += 1;
    searchToken += 1;
    clearNode(elements.globalSearchResults);
    elements.globalSearchInput.value = '';
    elements.globalSearchBanner.hidden = true;
    elements.libraryWarning.hidden = true;
    elements.refreshResult.hidden = true;
    elements.largeSessionNotice.hidden = true;
    elements.emptyState.hidden = true;
    elements.readTitle.textContent = '';
    clearNode(elements.readMount);
    inFileSearch.onReadDeactivated();
    sourceMode = 'folder';
    elements.libraryPath.textContent = 'Codex 文件夹 · 路径仅在本次运行中保留';
    syncSourceControls();
  }

  function renderSelectedBody(note) {
    clearNode(elements.readMount);
    const fragment = viewer.renderMarkdown(note.body || '', { document: doc });
    elements.readMount.appendChild(fragment);
    elements.largeSessionNotice.hidden = true;
    inFileSearch.onReadActivated();
    inFileSearch.refreshAfterRender();
    if (pendingSearchQuery) inFileSearch.searchAndReveal(pendingSearchQuery);
    pendingSearchQuery = '';
  }

  function selectSession(id, searchQuery = '') {
    const note = sessions.find((candidate) => candidate.id === id);
    if (!note) return false;
    selectedId = note.id;
    pendingSearchQuery = searchQuery;
    elements.readTitle.textContent = note.title || '未命名会话';
    renderTree();
    inFileSearch.onReadDeactivated();
    clearNode(elements.readMount);
    if (viewer.isLargeSession(note)) {
      elements.largeSessionNotice.hidden = false;
      return true;
    }
    renderSelectedBody(note);
    return true;
  }

  function loadSelectedLargeSession() {
    if (sourceMode !== 'library') return directView.load();
    const note = sessions.find((candidate) => candidate.id === selectedId);
    if (!note) return false;
    renderSelectedBody(note);
    return true;
  }

  function toggleFavorite(relativePath) {
    if (sourceMode !== 'library') return;
    favorites.toggle(relativePath);
    renderTree();
  }

  function applyLoadResult(result) {
    if (!result || !result.ok) {
      replaceSessions([], null);
      const reason = result && result.reason;
      setStatus(
        reason === 'no-library'
          ? '选择本地来源，开始回看对话。'
          : '无法打开所选会话库，请重新选择。',
        reason !== 'no-library',
      );
      return false;
    }
    replaceSessions(result.sessions, result.libraryPath);
    if (Number.isSafeInteger(result.skippedFiles) && result.skippedFiles > 0) {
      const count = result.skippedFiles;
      elements.libraryWarning.textContent = `${count} 个会话文件未能读取。文件需可安全读取且不超过 50 MiB，可重新选择此库再试，无需重新导入。`;
      elements.libraryWarning.hidden = false;
    }
    setStatus(`已载入 ${sessions.length} 个会话。`, false);
    return true;
  }

  async function initialize() {
    if (sourceBusy || folderView.isBusy()) return false;
    sourceBusy = true;
    setStatus('正在连接本地会话库…');
    syncSourceControls();
    try {
      if (sessionApi.restoreCodexFolder && hasFolderUi) {
        const restored = await sessionApi.restoreCodexFolder();
        if (restored?.ok) { folderView.restore(restored.catalog); setStatus('已连接 Codex，选择一段对话开始阅读。'); return true; }
        if (restored?.reason !== 'library-selected') {
          setStatus('尚未找到可用的 Codex 来源，请选择本地来源。'); return false;
        }
      }
      const result = await sessionApi.loadSessions();
      if (!result?.ok && result?.reason === 'invalid-library' && sessionApi.restoreCodexFolder) {
        setStatus('之前的 Markdown 会话库暂不可用，可在“本地来源”中连接 Codex 或重新选择。'); return false;
      }
      return applyLoadResult(result);
    }
    catch { setStatus('无法打开之前的会话库，请重试或选择其他来源。', true, initialize); return false; }
    finally { sourceBusy = false; syncSourceControls(); }
  }

  async function chooseLibrary() {
    if (sourceBusy || folderView.isBusy()) return false;
    sourceBusy = true;
    syncSourceControls();
    try {
      setStatus('正在打开会话库…', false);
      const result = await sessionApi.chooseLibrary();
      if (result && result.ok) return applyLoadResult(result);
      setStatus(result && result.reason === 'cancelled' ? '' : '无法打开所选会话库，请重新选择。', !(result && result.reason === 'cancelled'));
      return false;
    } catch { setStatus('无法打开所选会话库，请重新选择。', true); return false; }
    finally { sourceBusy = false; syncSourceControls(); }
  }

  async function openDirectSource(action) {
    if (sourceBusy || refreshInFlight || folderView.isBusy() ||
        action === 'reload' && sourceMode !== 'codex' ||
        action === 'back' && sourceMode === 'library') return false;
    sourceBusy = true;
    syncSourceControls();
    try {
      setStatus(action === 'choose' || action === 'restore' ? '正在打开 Codex 文件…' : action === 'reload' ? '正在重新读取会话…' : '正在返回会话库…');
      const result = await (action === 'choose' ? sessionApi.chooseCodexFile()
        : action === 'reload' || action === 'restore' ? sessionApi.reloadCodexFile() : sessionApi.loadSessions());
      if (action === 'back' && result && (result.ok || result.reason === 'no-library')) {
        return applyLoadResult(result);
      }
      if (action !== 'back' && result && result.ok) {
        replaceSessions([], null);
        sourceMode = 'codex';
        syncSourceControls();
        directView.show(result.session);
        setStatus('已载入只读会话，后续变化将自动检查。', false);
        syncSourceControls();
        return true;
      }
      if (result && result.reason === 'cancelled') { setStatus('已取消，当前内容保持不变。'); return false; }
      const detail = result && result.reason === 'over-cap' ? ' 文件超过 50 MiB。'
        : result && result.reason === 'decompression-failed' ? ' 压缩记录损坏、不完整或格式暂不支持。'
        : result && result.reason === 'decompression-limit' ? ' 压缩会话超出解码处理上限。'
        : result && result.reason === 'record-too-large' ? ' 记录超出结构处理上限。'
        : result && result.reason === 'message-too-large' ? ' 正文超出安全读取预算。'
        : result && result.reason === 'source-changed' ? ' 读取过程中源文件发生变化，请重试。'
        : result && result.reason === 'platform-unsupported' ? ' 当前系统不支持安全读取此文件。' : '';
      directFailure(action, detail);
      return false;
    } catch { directFailure(action, ''); return false; }
    finally { sourceBusy = false; syncSourceControls(); }
  }

  function directFailure(action, detail) {
    if (action === 'reload') directView.markStale();
    setStatus((action === 'reload' ? '重新读取失败，当前内容已保留，可能不是最新。'
      : action === 'back' ? '之前的 Markdown 会话库不可用。请在“本地来源”中重新选择，当前 Codex 内容已保留。'
        : '无法打开文件，请选择可读取的 Codex 会话文件。') + detail, true, () => openDirectSource(action));
  }
  const chooseCodexFile = () => openDirectSource('choose');
  const reloadCodexFile = () => openDirectSource('reload');
  const backToLibrary = () => openDirectSource('back');
  const chooseCodexFolder = () => folderView.choose();
  const rescanCodexFolder = () => folderView.rescan();
  const cancelCodexFolderScan = () => folderView.cancel();
  const openCodexCatalogEntry = (entryId) => folderView.openEntry(entryId);
  const reloadCodexFolderEntry = () => folderView.reload();

  async function refreshSessions() {
    if (!libraryPath || refreshInFlight || sourceBusy || folderView.isBusy() || sourceMode !== 'library') return false;
    refreshInFlight = true;
    syncSourceControls();
    const generation = libraryGeneration;
    elements.refreshResult.hidden = true;
    let result;
    let reloading = false;
    try {
      setStatus('正在导入 Codex 和 Claude 会话…', false);
      result = await sessionApi.refreshSessions();
      if (generation !== libraryGeneration) return false;
      if (!result || !result.ok && !(result.claude && result.codex)) {
        showRefreshResult(result);
        return false;
      }
      reloading = true;
      const loaded = await sessionApi.loadSessions();
      if (generation !== libraryGeneration) return false;
      const selected = sessions.find((note) => note.id === selectedId);
      const loadOk = applyLoadResult(loaded);
      if (loadOk && selected) {
        const replacement = sessions.find((note) => note.relativePath === selected.relativePath);
        if (replacement) selectSession(replacement.id);
      }
      showRefreshResult(result, !loadOk);
      return result.ok && loadOk;
    } catch {
      if (generation === libraryGeneration) showRefreshResult(result, reloading);
      return false;
    } finally {
      refreshInFlight = false;
      syncSourceControls();
    }
  }

  function showRefreshResult(result, reloadFailed = false) {
    const { text, isError } = formatRefreshResult(result, reloadFailed);
    elements.refreshResult.textContent = text;
    elements.refreshResult.hidden = false;
    elements.refreshResult.dataset.kind = isError ? 'error' : 'status';
    setStatus(reloadFailed ? '无法重新读取会话库。' : text.split('\n')[0], isError);
  }

  async function searchAll(query) {
    if (sourceMode !== 'library') return [];
    const normalized = String(query || '').trim();
    const token = ++searchToken;
    if (normalized.length < viewer.MIN_GLOBAL_QUERY_LEN) {
      viewer.renderGlobalResults(elements.globalSearchResults, [], doc);
      elements.globalSearchBanner.hidden = true;
      return [];
    }
    const generation = libraryGeneration;
    const state = indexState;
    elements.globalSearchBanner.hidden = false;
    elements.globalSearchBanner.textContent = '正在建立会话搜索索引…';
    if (!indexPromise) {
      indexPromise = viewer.loadGlobalIndex(
        state,
        sessions,
        async (item) => ({ content: item.body || '' }),
        (content) => viewer.extractReadTextRuns(content),
        () => true,
      );
    }
    await indexPromise;
    if (token !== searchToken || generation !== libraryGeneration || state !== indexState) {
      return [];
    }
    const results = viewer.searchIndex(state.globalIndex, normalized);
    elements.globalSearchBanner.hidden = false;
    elements.globalSearchBanner.textContent = results.length ? `找到 ${results.length} 个匹配会话。` : '没有找到匹配内容，试试其他关键词。';
    viewer.renderGlobalResults(
      elements.globalSearchResults,
      results,
      doc,
      (id) => {
        if (token !== searchToken || generation !== libraryGeneration) return;
        selectSession(id, normalized);
      },
      { isFavorite: (id) => favorites.isFavorite(id) },
    );
    return results;
  }

  syncSourceControls();
  for (const [name, action] of [
    ['cancelCodexReadButton', async () => {
      setStatus('正在取消读取…');
      try { await sessionApi.cancelCodexPage(); } catch { setStatus('暂时无法取消读取，请稍后再试。', true); }
    }],
    ['openCodexFileButton', chooseCodexFile],
    ['openCodexFolderButton', chooseCodexFolder],
    ['reloadCodexFileButton', reloadCodexFile],
    ['reloadCodexFolderButton', reloadCodexFolderEntry],
    ['rescanCodexFolderButton', rescanCodexFolder],
    ['cancelCodexFolderScanButton', cancelCodexFolderScan],
    ['backToLibraryButton', backToLibrary],
  ]) {
    if (elements[name]) elements[name].addEventListener('click', () => { void action(); });
  }
  if (elements.chooseLibraryButton.addEventListener) {
    elements.chooseLibraryButton.addEventListener('click', () => { void chooseLibrary(); });
  }
  if (elements.refreshButton && elements.refreshButton.addEventListener) {
    elements.refreshButton.addEventListener('click', () => { void refreshSessions(); });
  }
  if (elements.globalSearchInput.addEventListener) {
    elements.globalSearchInput.addEventListener('input', () => {
      void searchAll(elements.globalSearchInput.value);
    });
  }
  if (elements.loadLargeSessionButton.addEventListener) {
    elements.loadLargeSessionButton.addEventListener('click', loadSelectedLargeSession);
  }

  return {
    initialize,
    async initializeWindow(initial) {
      if (initial?.direct) return openDirectSource('restore');
      const loaded = await initialize();
      if (!loaded || !initial?.target) return loaded;
      const target = initial.target;
      if (target.kind === 'folder') {
        const entry = folderView.getState().entries.find(item => item.sessionId === target.id);
        if (entry) return openCodexCatalogEntry(entry.entryId);
      } else if (target.kind === 'library' && sessions.some(item => item.id === target.id)) {
        selectSession(target.id); return true;
      }
      setStatus('此会话已移除或不再可用，请从列表选择其他会话。', true);
      return false;
    },
    refreshSharedState() {
      favorites.reload();
      if (sourceMode === 'folder') folderView.refreshFavorites();
      else if (sourceMode === 'library') renderTree();
    },
    chooseCodexFile, reloadCodexFile, backToLibrary,
    chooseCodexFolder, rescanCodexFolder, cancelCodexFolderScan,
    openCodexCatalogEntry, reloadCodexFolderEntry,
    chooseLibrary,
    refreshSessions,
    selectSession,
    toggleFavorite,
    setListFilter(next) {
      listFilter = { agent: ['codex', 'claude', 'other'].includes(next.agent) ? next.agent : 'all',
        query: String(next.query || ''), favoritesOnly: !!next.favoritesOnly };
      if (sourceMode === 'folder') { folderView.setFavoritesOnly(listFilter.favoritesOnly); folderView.filter(listFilter.query); }
      else if (sourceMode === 'library') renderTree();
    },
    getSelectedFavorite() {
      if (sourceMode === 'folder') return folderView.isFavorite(folderView.getState().selectedSessionId);
      return sourceMode === 'library' && !!selectedId && favorites.isFavorite(sessions.find(s => s.id === selectedId)?.relativePath);
    },
    toggleSelectedFavorite() {
      if (sourceMode === 'folder') { const id = folderView.getState().selectedSessionId; if (id) folderView.toggleFavorite(id); }
      else if (sourceMode === 'library' && selectedId) toggleFavorite(sessions.find(s => s.id === selectedId)?.relativePath);
    },
    searchAll,
    loadSelectedLargeSession,
    isBusy: () => sourceBusy || refreshInFlight || folderView.isBusy() || directView.isBusy(),
    isFollowingLatest: () => directView.isFollowingLatest(),
    showLatest: () => directView.move('latest'),
    syncCodexChanges(result) { if (result.catalog && sourceMode === 'folder') folderView.acceptBackground(result.catalog); },
    showCodexSearchHit(result) {
      if (sourceMode === 'folder') folderView.acceptHit(result); else directView.show(result.session);
      setStatus('已定位到搜索结果。');
      const section = elements.readMount.querySelectorAll?.('.read-section')[result.message];
      const found = inFileSearch.searchAndReveal(result.query, section);
      if (!found && section) { directView.revealMatch(section); section.scrollIntoView({ block: 'center' }); }
    },
    getState: () => ({ sourceMode, cwd: directView.getCwd(), readerId: directView.getReaderId(), sessions: sessions.slice(), selectedId, libraryPath, folder: folderView.getState() }),
  };
}

const api = { createSessionApp };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.SessionApp = api;

})();
