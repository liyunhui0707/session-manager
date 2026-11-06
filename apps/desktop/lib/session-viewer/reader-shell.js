'use strict';
(function () {
const PREFERENCE_KEY = 'aiSessionManager.readerAppearance';
const choices = { theme: ['system', 'light', 'dark'], font: ['medium', 'small', 'large', 'xlarge', 'xxlarge', 'xxxlarge', 'xxxxlarge'], width: ['comfortable', 'wide'] };
function normalizePreferences(value) {
  return Object.fromEntries(Object.entries(choices).map(([key, allowed]) => [key,
    allowed.includes(value?.[key]) ? value[key] : allowed[0]]));
}
function createReaderShell({ document: doc, app, storage }) {
  const byId = id => doc.getElementById(id);
  let preferences;
  try { preferences = normalizePreferences(JSON.parse(storage.getItem(PREFERENCE_KEY))); }
  catch { preferences = normalizePreferences(); }
  let favoritesOnly = false, agent = 'all', sourceKey = null;
  const text = (id, value) => { const node = byId(id); if (node && node.textContent !== value) node.textContent = value; };
  const pressed = (node, value) => node?.setAttribute('aria-pressed', String(value));
  const on = (id, event, fn) => byId(id)?.addEventListener(event, fn);
  function applyPreferences() {
    for (const [key, value] of Object.entries(preferences)) doc.documentElement.dataset[key] = value;
    for (const button of doc.querySelectorAll('[data-preference]')) {
      pressed(button, preferences[button.dataset.preference] === button.dataset.value);
    }
  }
  function setPreference(key, value) {
    if (!choices[key]?.includes(value)) return;
    preferences = normalizePreferences({ ...preferences, [key]: value });
    applyPreferences();
    try { storage.setItem(PREFERENCE_KEY, JSON.stringify(preferences)); } catch { /* appearance still works in memory */ }
  }
  function adjustFont(delta) {
    const sizes = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'xxxlarge', 'xxxxlarge'];
    setPreference('font', sizes[Math.max(0, Math.min(sizes.length - 1, sizes.indexOf(preferences.font) + delta))]);
  }
  function openDialog(id, focusId) {
    const dialog = byId(id);
    if (!dialog || dialog.open) return;
    for (const other of doc.querySelectorAll('dialog[open]')) other.close();
    const previous = doc.activeElement;
    dialog.addEventListener('close', () => previous?.focus(), { once: true });
    dialog.showModal();
    if (focusId) { byId(focusId)?.focus(); byId(focusId)?.select(); }
  }
  function openSearch() {
    sync();
    openDialog('searchDialog', app.getState().sourceMode === 'library' ? 'globalSearchInput' : 'codexSearchInput');
  }
  function openFind() {
    if (byId('inFileSearchToolbar').hidden) return;
    doc.documentElement.dataset.find = 'open';
    byId('inFileSearchInput').focus();
    byId('inFileSearchInput').select();
  }
  function filter() {
    const state = app.getState();
    app.setListFilter({ favoritesOnly, agent,
      query: byId(state.sourceMode === 'folder' ? 'folderFilterInput' : 'libraryFilterInput').value });
    pressed(byId('favoritesFilter'), favoritesOnly);
    text('listHeading', favoritesOnly ? '收藏会话' : '最近会话');
  }
  function sync() {
    const state = app.getState(), folder = state.sourceMode === 'folder', library = state.sourceMode === 'library';
    const nextKey = `${state.sourceMode}:${state.folder?.sourceId || state.libraryPath || ''}`;
    if (nextKey !== sourceKey) {
      const initial = sourceKey === null;
      sourceKey = nextKey; favoritesOnly = false; agent = 'all';
      byId('libraryFilterInput').value = '';
      if (!initial) filter();
    }
    pressed(byId('favoritesFilter'), favoritesOnly);
    byId('favoritesFilter').disabled = !folder && !library;
    const selected = folder ? state.folder?.selectedEntryId : library ? state.selectedId : null;
    byId('readerFavorite').disabled = !selected;
    pressed(byId('readerFavorite'), app.getSelectedFavorite());
    byId('readerFavorite').setAttribute('aria-label', app.getSelectedFavorite() ? '取消收藏' : '收藏会话');
    byId('findButton').disabled = byId('inFileSearchToolbar').hidden;
    byId('libraryFilter').hidden = !library;
    byId('librarySourceTabs').hidden = !library || !state.sessions?.length;
    byId('currentSourceChip').hidden = true;
    for (const button of doc.querySelectorAll('[data-agent]')) pressed(button, button.dataset.agent === agent);
    text('currentSourceChip', folder ? 'Codex · 未归档对话' : 'Codex · 单文件');
    const count = folder ? state.folder?.entries?.length || 0 : state.sessions?.length || 0;
    const connected = !library || !!state.libraryPath;
    text('welcomeTitle', connected ? count ? '选择一段对话，继续回看。' : '这里还没有可显示的对话。' : '好对话，值得再读一次。');
    text('welcomeHint', connected ? count ? '从左侧选择会话，或使用搜索找回一段内容。' : '可以连接其他来源；Codex 归档和后台任务不会显示在这里。' : '找回一个想法，重温一个答案。按照自己的节奏，回看每一次对话。');
    byId('welcomeConnect').hidden = connected && count > 0;
    text('sourceSummary', folder ? 'Codex 文件夹' : library ? state.libraryPath ? 'Markdown 会话库' : '连接本地来源' : 'Codex 单文件');
    text('sourceSubtitle', folder ? `${count} 个未归档对话 · 自动更新` : library ? `${count} 个会话 · 本地只读` : '只读会话快照');
    text('readerMeta', byId('readTitle').textContent ? state.cwd || '' : '你的对话，安静收藏');
    byId('readerMeta').title = state.cwd || '';
    byId('readerMeta').hidden = !!byId('readTitle').textContent && !state.cwd;
    text('searchScopeHint', library ? '搜索所选 Markdown 库的正文' : '搜索完整会话的提示词与最终回复；结果可能因读取限制而不完整。');
    byId('searchUnavailable').hidden = !library || !!state.libraryPath;
    byId('searchLaunch').disabled = library && !state.libraryPath;
    text('readerMode', folder || !library ? '自动检查更新 · 只读' : '本地阅读 · 只读');
    text('readerPosition', '');
  }
  on('fontDecrease', 'click', () => adjustFont(-1));
  on('fontIncrease', 'click', () => adjustFont(1));
  on('searchLaunch', 'click', openSearch);
  on('findButton', 'click', openFind);
  on('findClose', 'click', () => { doc.documentElement.dataset.find = 'closed'; byId('findButton').focus(); });
  on('sourcesButton', 'click', () => openDialog('sourcesDialog'));
  on('welcomeConnect', 'click', () => openDialog('sourcesDialog'));
  on('settingsButton', 'click', () => openDialog('settingsDialog'));
  on('detailsButton', 'click', () => openDialog('detailsDialog'));
  on('favoritesFilter', 'click', () => { favoritesOnly = !favoritesOnly; filter(); });
  on('readerFavorite', 'click', () => { app.toggleSelectedFavorite(); sync(); });
  on('libraryFilterInput', 'input', filter);
  for (const button of doc.querySelectorAll('[data-agent]')) button.addEventListener('click', () => {
    agent = button.dataset.agent; filter(); sync();
  });
  for (const button of doc.querySelectorAll('[data-preference]')) button.addEventListener('click', () => setPreference(button.dataset.preference, button.dataset.value));
  for (const button of doc.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => button.closest('dialog').close());
  // Close the modal before launching a native chooser. Errors remain visible in the reader.
  for (const id of ['openCodexFolderButton', 'openCodexFileButton', 'chooseLibraryButton', 'backToLibraryButton']) {
    on(id, 'click', () => byId('sourcesDialog').close());
  }
  for (const id of ['globalSearchResults']) on(id, 'click', event => {
    if (event.target.closest?.('.codex-search-hit, .sidebar-search-result-row')) byId('searchDialog').close();
  });
  doc.addEventListener('keydown', event => {
    if (event.isComposing || event.altKey) return;
    if ((event.metaKey || event.ctrlKey) && ['+', '=', '-', '0'].includes(event.key) &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) && !event.target?.isContentEditable) {
      event.preventDefault();
      if (event.key === '0') setPreference('font', 'medium'); else adjustFont(event.key === '-' ? -1 : 1);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); if (!byId('searchLaunch').disabled) openSearch();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      if (!doc.querySelectorAll('dialog[open]').length) { event.preventDefault(); openFind(); }
    } else if (event.key === 'Escape' && !doc.querySelectorAll('dialog[open]').length) {
      doc.documentElement.dataset.find = 'closed';
    }
  });
  applyPreferences(); doc.documentElement.dataset.find = 'closed'; sync();
  return { sync, setPreference };
}
const api = { createReaderShell, normalizePreferences };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);
})();
