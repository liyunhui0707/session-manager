'use strict';

(function () {

const MAX_MOUNTED_ROWS = 250;
const FAVORITES_PREFIX = 'aiSessionManager.codexSourceFavorites.';

function clearNode(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function createCodexFolderView(options) {
  const { document: doc, elements, sessionApi, storage, directView } = options || {};
  const createFavoritesController = options && options.createFavoritesController;
  if (!doc || !elements || !sessionApi || !directView || typeof createFavoritesController !== 'function') {
    throw new Error('codex-folder-view: required options missing');
  }
  let current = null;
  let favorites = null;
  let query = '';
  let favoritesOnly = false;
  let page = 0;
  let scanning = false;
  let loading = false;
  let requestToken = 0;
  let selectedEntryId = null;
  let selectedSessionId = null;

  function notify() { if (typeof options.onStateChange === 'function') options.onStateChange(); }
  function status(message, isError = false, retry = null) {
    if (typeof options.onStatus === 'function') options.onStatus(message, isError, retry);
  }
  function failedSelection(entry, reason) {
    const displayed = current.entries.find((item) => item.entryId === selectedEntryId);
    const detail = reason === 'cancelled' ? '已取消读取。' : reason === 'over-cap'
      ? '此会话超出当前读取限制。'
      : reason === 'decompression-failed' ? '压缩记录损坏、不完整或格式暂不支持。'
      : reason === 'decompression-limit' ? '压缩会话超出解码处理上限。'
      : reason === 'record-too-large' ? '记录超出结构处理上限。'
      : reason === 'message-too-large' ? '正文超出安全读取预算。'
      : reason === 'source-changed' ? '读取过程中源文件发生变化，请重试。'
      : '此会话暂时不可用，可在“本地来源”中同步列表后重试。';
    status(`未能打开“${entry.title}”。${detail}${displayed ? ` 当前仍显示“${displayed.title}”。` : ''}`, reason !== 'cancelled', () => openEntry(entry.entryId));
  }
  function isFavorite(sessionId) { return !!favorites && favorites.isFavorite(sessionId); }
  function visibleEntries() {
    if (!current) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return current.entries.filter(entry => (!favoritesOnly || isFavorite(entry.sessionId)) &&
      (!normalized || entry.title.toLocaleLowerCase().includes(normalized) ||
      entry.sessionId.toLocaleLowerCase().includes(normalized)));
  }
  function appendGroup(container, label, entries) {
    if (!entries.length) return;
    const group = doc.createElement('section');
    group.className = 'session-group';
    const heading = doc.createElement('div');
    heading.className = 'session-group-header';
    heading.appendChild(doc.createTextNode(label));
    const count = doc.createElement('span');
    count.className = 'session-group-count';
    count.appendChild(doc.createTextNode(String(entries.length)));
    heading.appendChild(count);
    group.appendChild(heading);
    for (const entry of entries) {
      const row = doc.createElement('div');
      row.className = entry.entryId === selectedEntryId ? 'session-row session-row--active' : 'session-row';
      row.setAttribute('role', 'button');
      row.setAttribute('data-entry-id', entry.entryId);
      row.setAttribute('tabindex', '0');
      const star = doc.createElement('button');
      star.className = isFavorite(entry.sessionId) ? 'session-star session-star--on' : 'session-star';
      star.setAttribute('type', 'button');
      star.setAttribute('aria-label', isFavorite(entry.sessionId) ? '取消收藏' : '收藏会话');
      star.appendChild(doc.createTextNode(isFavorite(entry.sessionId) ? '★' : '☆'));
      if (star.addEventListener) star.addEventListener('click', (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        toggleFavorite(entry.sessionId);
      });
      if (star.addEventListener) star.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        toggleFavorite(entry.sessionId);
      });
      const title = doc.createElement('span');
      title.className = 'session-row-title';
      title.appendChild(doc.createTextNode(entry.title));
      row.appendChild(star);
      row.appendChild(title);
      const open = () => { void openEntry(entry.entryId); };
      if (row.addEventListener) {
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') open();
        });
      }
      group.appendChild(row);
    }
    container.appendChild(group);
  }
  function render() {
    clearNode(elements.sessionList);
    const filtered = visibleEntries();
    const pages = Math.max(1, Math.ceil(filtered.length / MAX_MOUNTED_ROWS));
    if (page >= pages) page = pages - 1;
    const start = page * MAX_MOUNTED_ROWS;
    const shown = filtered.slice(start, start + MAX_MOUNTED_ROWS);
    appendGroup(elements.sessionList, '未归档', shown.filter((entry) => entry.area === 'active'));
    appendGroup(elements.sessionList, '已归档', shown.filter((entry) => entry.area === 'archive'));
    if (!filtered.length) {
      const empty = doc.createElement('p'); empty.className = 'empty-state';
      empty.textContent = query.trim() ? '没有找到匹配的会话，试试其他标题或 ID。' : favoritesOnly ? '还没有收藏的会话，点击会话旁的星标即可收藏。' : '此来源暂无可显示的未归档对话。';
      elements.sessionList.appendChild(empty);
    }
    elements.folderPrevPageButton.disabled = page === 0;
    elements.folderNextPageButton.disabled = page >= pages - 1;
    elements.folderPageStatus.textContent = filtered.length
      ? `${start + 1}–${start + shown.length} / 共 ${filtered.length} 个` : '0 个会话';
  }
  function showDiagnostics() {
    if (!current) { elements.folderDiagnostics.hidden = true; return; }
    const d = current.diagnostics;
    elements.folderDiagnostics.textContent = `${current.entries.length} 个会话 · ${current.layout === 'full' ? '完整 Codex 目录' : '未归档会话目录'} · 只读索引。跳过 ${d.skipped} 项；${d.errors} 项读取错误；${d.duplicates} 项重复；${d.indexErrors} 项名称索引错误。`;
    if (current.layout === 'active-only') elements.folderDiagnostics.textContent += ' 如需读取保存的名称，请选择包含 sessions 和 session_index.jsonl 的上级 Codex 文件夹。';
    if (d.hiddenReviews) elements.folderDiagnostics.textContent += ` 已根据来源信息隐藏 ${d.hiddenReviews} 个后台审核。可通过单文件入口查看，源文件未删除。`;
    if (d.hiddenBackground) elements.folderDiagnostics.textContent += ` 已根据来源信息隐藏 ${d.hiddenBackground} 个子代理或后台会话。可通过单文件入口查看，源文件未删除。`;
    if (d.hiddenAutomation) elements.folderDiagnostics.textContent += ` 已隐藏 ${d.hiddenAutomation} 个非交互记录（exec / mcp）。可通过单文件入口查看，源文件未删除。`;
    if (d.hiddenEmpty) elements.folderDiagnostics.textContent += ` 已隐藏 ${d.hiddenEmpty} 个仅初始化、没有对话的记录；新增消息后会自动重新显示。`;
    if (d.originUnknown) elements.folderDiagnostics.textContent += ` ${d.originUnknown} 项来源尚未确认，仍保留显示。`;
    const reasons = d.skippedReasons;
    if (reasons) elements.folderDiagnostics.textContent += ` 排除项：${reasons.compressed} 项压缩文件名不支持（.jsonl.zst）；${reasons.unsupportedName} 项文件名不支持；${reasons.layout} 项不符合日期目录布局；${reasons.unsafe} 项无法安全读取；${reasons.other} 项其他。这些是文件项数，不代表丢失的会话数量。`;
    const notice = elements.folderSourceNotice;
    if (notice) {
      const titleStatus = current.layout === 'active-only'
        ? '仅显示未归档对话 · 名称尚未载入。'
        : current.titleIndexState === 'loaded'
          ? `${current.entries.length} 个未归档对话中，${d.named || 0} 个已读取名称 · 自动更新。`
          : current.titleIndexState === 'unavailable'
            ? '名称索引暂不可用，没有名称的会话显示 ID。'
            : '此文件夹没有名称索引，没有名称的会话显示 ID。';
      notice.textContent = titleStatus + (d.hiddenReviews ? ` 已隐藏 ${d.hiddenReviews} 个后台审核。` : '') +
        (d.hiddenBackground ? ` 已隐藏 ${d.hiddenBackground} 个子代理或后台会话。` : '') +
        (d.hiddenAutomation ? ` 已隐藏 ${d.hiddenAutomation} 个非交互记录。` : '') +
        (d.skipped ? ` 已排除 ${d.skipped} 项，详见技术诊断。` : '');
      notice.hidden = false;
    }
    elements.folderDiagnostics.hidden = false;
  }
  function acceptCatalog(next, replacingSource, background = false) {
    const previousSessionId = replacingSource ? null : selectedSessionId;
    current = next;
    favorites = createFavoritesController({ storage, key: FAVORITES_PREFIX + next.sourceId });
    selectedEntryId = next.selectedEntryId ||
      (previousSessionId && next.entries.find((entry) => entry.sessionId === previousSessionId)?.entryId) || null;
    selectedSessionId = selectedEntryId
      ? next.entries.find((entry) => entry.entryId === selectedEntryId)?.sessionId || null : null;
    if (replacingSource) directView.clear();
    else if (previousSessionId && !selectedSessionId) {
      directView.clear();
      status('当前会话已归档、移除或不再符合显示条件。请选择其他会话。', true);
    }
    if (!background) { query = ''; page = 0; elements.folderFilterInput.value = ''; }
    if (selectedEntryId) directView.rename?.(next.entries.find(e => e.entryId === selectedEntryId)?.title);
    showDiagnostics();
    render();
  }
  async function runScan(action) {
    if (scanning || loading) return false;
    scanning = true;
    const token = ++requestToken;
    status(action === 'choose' ? '正在读取所选 Codex 文件夹…' : '正在同步 Codex 会话列表…');
    notify();
    try {
      const result = await (action === 'choose'
        ? sessionApi.chooseCodexFolder() : sessionApi.rescanCodexFolder());
      if (token !== requestToken) return false;
      if (!result || !result.ok) {
        status(result && result.reason === 'cancelled' ? '已取消扫描，原有列表保持不变。' : '暂时无法读取 Codex 文件夹，请重试。', result && result.reason !== 'cancelled', result?.reason === 'cancelled' ? null : () => runScan(action));
        return false;
      }
      if (action === 'choose' && typeof options.onActivate === 'function') options.onActivate();
      acceptCatalog(result.catalog, action === 'choose');
      status(result.preferenceWarning ? '已连接，但未能保存目录位置；下次启动可能需要重新选择。' : `已载入 ${result.catalog.entries.length} 个 Codex 对话。`, !!result.preferenceWarning);
      return true;
    } catch {
      if (token === requestToken) status('暂时无法读取 Codex 文件夹，请重试。', true, () => runScan(action));
      return false;
    } finally {
      if (token === requestToken) { scanning = false; notify(); }
    }
  }
  async function openEntry(entryId) {
    const entry = current && current.entries.find((item) => item.entryId === entryId);
    if (!entry || scanning || loading || directView.isBusy?.()) return false;
    loading = true;
    const token = ++requestToken;
    status('正在读取最新消息… 较长或压缩的会话可能需要一些时间。');
    notify();
    try {
      const result = await sessionApi.loadCodexCatalogEntry(entryId);
      if (token !== requestToken) return false;
      if (!result || !result.ok) {
        failedSelection(entry, result && result.reason);
        return false;
      }
      if (result.generation !== current.generation || result.entryId !== entryId) return false;
      selectedEntryId = entryId;
      selectedSessionId = entry.sessionId;
      directView.show(result.session, { sourceLabel: 'Codex 文件夹', cwd: current?.entries.find(e => e.entryId === selectedEntryId)?.cwd || '' });
      render();
      status('已载入会话，后续变化将自动检查。');
      return true;
    } catch {
      if (token === requestToken) failedSelection(entry);
      return false;
    }
    finally { if (token === requestToken) { loading = false; notify(); } }
  }
  async function reload() {
    if (!current || !selectedEntryId || scanning || loading) return false;
    loading = true;
    const token = ++requestToken;
    status('正在重新读取当前会话…');
    notify();
    try {
      const result = await sessionApi.reloadCodexCatalogEntry();
      if (token !== requestToken) return false;
      if (!result || !result.ok) {
        if (result?.reason === 'cancelled') { status('已取消读取，当前内容已保留。', false, reload); return false; }
        directView.markStale();
        status('重新读取失败，当前内容已保留，可能不是最新。', true, reload);
        return false;
      }
      if (result.generation !== current.generation || result.entryId !== selectedEntryId) {
        return false;
      }
      directView.show(result.session, { sourceLabel: 'Codex 文件夹', cwd: current?.entries.find(e => e.entryId === selectedEntryId)?.cwd || '' });
      status('已重新读取当前会话。');
      return true;
    } catch { directView.markStale(); status('重新读取失败，当前内容已保留，可能不是最新。', true, reload); return false; }
    finally { if (token === requestToken) { loading = false; notify(); } }
  }
  async function cancel() {
    if (!scanning) return false;
    status('正在取消扫描…');
    try { return !!(await sessionApi.cancelCodexFolderScan())?.ok; }
    catch { return false; }
  }
  function filter(value) { query = String(value || ''); page = 0; render(); }
  function toggleFavorite(sessionId) { if (!favorites) return false; const value = favorites.toggle(sessionId); render(); return value; }
  function clear() {
    requestToken += 1;
    current = null; favorites = null; selectedEntryId = null; selectedSessionId = null;
    query = ''; page = 0; scanning = false; loading = false;
    clearNode(elements.sessionList);
    elements.folderDiagnostics.hidden = true;
    if (elements.folderSourceNotice) elements.folderSourceNotice.hidden = true;
    notify();
  }
  elements.folderPrevPageButton.addEventListener('click', () => { if (page > 0) { page -= 1; render(); } });
  elements.folderNextPageButton.addEventListener('click', () => { page += 1; render(); });
  elements.folderFilterInput.addEventListener('input', () => filter(elements.folderFilterInput.value));
  return {
    restore(catalog) { options.onActivate?.(); acceptCatalog(catalog, true); notify(); },
    choose: () => runScan('choose'), rescan: () => runScan('rescan'), cancel,
    acceptBackground: next => acceptCatalog(next, false, true),
    acceptHit(result) {
      selectedEntryId = result.entryId;
      selectedSessionId = current?.entries.find(e => e.entryId === result.entryId)?.sessionId;
      directView.show(result.session, { sourceLabel: 'Codex 文件夹', cwd: current?.entries.find(e => e.entryId === selectedEntryId)?.cwd || '' }); render();
    },
    setFavoritesOnly(value) { favoritesOnly = !!value; page = 0; render(); },
    refreshFavorites() { favorites?.reload(); if (current) render(); },
    openEntry, reload, filter, toggleFavorite, isFavorite, clear, render,
    isActive: () => current !== null,
    isBusy: () => scanning || loading,
    getState: () => ({ scanning, loading, sourceId: current?.sourceId, entries: current ? current.entries.slice() : [], selectedEntryId, selectedSessionId, generation: current && current.generation }),
  };
}

const api = { createCodexFolderView, MAX_MOUNTED_ROWS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);

})();
