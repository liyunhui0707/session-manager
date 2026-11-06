'use strict';
(function () {
const { revealMessageMatch } = typeof require !== 'undefined'
  ? require('./message-disclosure') : window.SessionViewer;
function createDirectSessionView({ elements, viewer, inFileSearch, document, sessionApi, onBusy, onStatus, onReload }) {
  let session = null;
  let diagnosticsText = '';
  let busy = false, request = 0, showOptions = {};
  function syncPager() {
    if (!elements.transcriptPager) return;
    const page = session && session.page;
    elements.transcriptPager.hidden = !page;
    elements.transcriptPrevious.disabled = busy || !page?.hasPrevious;
    elements.transcriptNext.disabled = busy || !page?.hasNext;
    elements.transcriptCancel.hidden = !busy;
    if (elements.transcriptFirst) { elements.transcriptFirst.hidden = !page?.conversationOnly; elements.transcriptFirst.disabled = busy; }
    if (elements.transcriptLatest) { elements.transcriptLatest.hidden = !page?.conversationOnly; elements.transcriptLatest.disabled = busy; }
    elements.transcriptPageStatus.textContent = page
      ? page.conversationOnly ? `第 ${page.number} / ${page.pages} 部分${page.hasNext ? '' : ' · 已到最新'}${page.waiting && !page.hasNext ? ' · 等待最终回复' : ''}`
        : page.compressed ? `第 ${page.number} 段 · 压缩记录 · ${page.hasNext ? '后面还有内容' : '已到末尾'}`
        : `第 ${page.number} 段 · 已扫描文件的 ${Math.floor(100 * page.scannedBytes / Math.max(1, page.totalBytes))}%` : '';
  }
  async function move(direction) {
    if (busy || !session?.page || !sessionApi) return false;
    const token = ++request;
    busy = true; syncPager(); onBusy?.(true);
    onStatus?.(direction === 'first' ? '正在读取最初消息…' : direction === 'previous' ? '正在读取较早消息…' : direction === 'latest' ? '正在读取最新消息…' : '正在读取较新消息…');
    try {
      const result = await sessionApi.moveCodexPage(session.page.readerId, direction);
      if (token !== request) return false;
      if (!result?.ok) {
        const messages = {
          'decompression-failed': '压缩记录损坏、不完整或格式暂不支持，当前内容已保留。',
          'decompression-limit': '压缩会话超出解码处理上限，当前内容已保留。',
          'source-changed': '会话文件已更新。点击重试以重新读取，当前内容已保留。',
          'stale-reader': '会话列表已更新，请重试以重新读取当前会话。',
          'record-too-large': '记录超出结构处理上限，当前内容已保留。',
          'message-too-large': '正文超出安全读取预算，当前内容已保留。',
          cancelled: '已取消读取，当前内容已保留。',
        };
        onStatus?.(messages[result?.reason] || '暂时无法读取这部分内容，当前内容已保留。请重试。', result?.reason !== 'cancelled',
          ['source-changed', 'stale-reader'].includes(result?.reason) ? onReload : () => move(direction));
        return false;
      }
      show(result.session, { ...showOptions, position: ['previous', 'latest'].includes(direction) ? 'bottom' : 'top' });
      onStatus?.('已载入。页内查找仅搜索当前部分；“搜索对话”可查找完整正文。');
      return true;
    } catch {
      if (token === request) onStatus?.('暂时无法读取这部分内容，当前内容已保留。请重试。', true, () => move(direction));
      return false;
    } finally {
      if (token === request) { busy = false; syncPager(); onBusy?.(false); }
    }
  }
  elements.transcriptFirst?.addEventListener('click', () => move('first'));
  elements.transcriptPrevious?.addEventListener('click', () => move('previous'));
  elements.transcriptNext?.addEventListener('click', () => move('next'));
  elements.transcriptLatest?.addEventListener('click', () => move('latest'));
  elements.transcriptCancel?.addEventListener('click', async () => {
    onStatus?.('正在取消读取…');
    try { await sessionApi.cancelCodexPage(); }
    catch { onStatus?.('暂时无法取消读取，请稍后再试。', true); }
  });
  function clear() {
    viewer.closeLocalImagePreview?.(document);
    request += 1;
    busy = false;
    session = null; showOptions = {};
    inFileSearch.onReadDeactivated();
    while (elements.readMount.firstChild) elements.readMount.removeChild(elements.readMount.firstChild);
    elements.readTitle.textContent = '';
    syncPager();
    if (elements.transcriptReadWarning) { elements.transcriptReadWarning.hidden = true; elements.transcriptReadWarning.textContent = ''; }
    if (elements.inFileSearchInput) {
      elements.inFileSearchInput.placeholder = '查找当前会话…';
      elements.inFileSearchInput.setAttribute('aria-label', '查找当前会话…');
    }
    if (elements.readMount.dataset) elements.readMount.dataset.source = '';
    if (elements.directDiagnostics) {
      elements.directDiagnostics.hidden = true;
      elements.directDiagnostics.textContent = '';
    }
  }
  function load() {
    if (!session) return false;
    viewer.closeLocalImagePreview?.(document);
    inFileSearch.onReadDeactivated();
    while (elements.readMount.firstChild) elements.readMount.removeChild(elements.readMount.firstChild);
    elements.readMount.appendChild(viewer.renderStructuredConversation(session.conversation, {
      document, collapseLongMessages: true,
      ...(session.page && sessionApi?.readCodexImage ? { loadImage: ((readerId, page) =>
        (message, image, size) => sessionApi.readCodexImage({ readerId, page, message, image, size }))(session.page.readerId, session.page.number) } : {}),
    }));
    if (session.page && !session.conversation.messages.length) {
      const empty = document.createElement('p');
      empty.appendChild(document.createTextNode(session.page.hasNext ? '这部分没有可显示的提示词或最终回复。可使用“较新消息”继续阅读。' : session.page.waiting ? '你的提示词已记录，正在等待最终回复。' : '此会话暂时没有可显示的提示词或最终回复。'));
      elements.readMount.appendChild(empty);
    }
    elements.largeSessionNotice.hidden = true;
    if (session.conversation.messages.length) {
      inFileSearch.onReadActivated();
      inFileSearch.refreshAfterRender();
    }
    if (elements.readMount.parentElement) elements.readMount.parentElement.scrollTop = (showOptions.position ? showOptions.position === 'bottom' : session.page?.latest) ? elements.readMount.parentElement.scrollHeight : 0;
    return true;
  }
  function show(next, options = {}) {
    session = next;
    showOptions = options;
    syncPager();
    if (elements.inFileSearchInput) {
      const label = session.page ? '查找当前部分…' : '查找当前会话…';
      elements.inFileSearchInput.placeholder = label;
      elements.inFileSearchInput.setAttribute('aria-label', label);
    }
    elements.readTitle.textContent = session.name;
    const sourceLabel = options.sourceLabel || 'Codex 单文件';
    elements.libraryPath.textContent = `${sourceLabel} · 只读快照`;
    elements.readMount.dataset.source = 'codex';
    elements.emptyState.hidden = true;
    const { messages, diagnostics: d } = session.conversation;
    diagnosticsText = [
      `${messages.length} 条消息${session.page ? '（当前部分）' : ''} · 只读快照，可重新读取以获取更新。`,
      `${d.malformedRecords} 条格式损坏记录；${d.unparsedFinalRecord} 条未写完或损坏的末尾记录；${d.unsupportedRecords} 条暂不支持的记录；${d.omittedContentBlocks} 个未显示的内容块；${d.excludedRecords} 条已按规则排除的记录。`,
      messages.length ? '仅显示对话正文，工具记录与暂不支持的内容不显示。' : `当前${session.page ? '部分' : '文件'}没有可显示的对话正文。`,
      session.page ? '统计与页内查找仅覆盖当前部分。切换较早或较新消息不会修改源文件。' : '页内查找搜索当前文件。返回会话库可使用分组、收藏与跨会话搜索。',
    ].join('\n');
    if (session.page?.conversationOnly) diagnosticsText = `当前部分有 ${messages.length} 条消息，仅显示提示词与最终回复。\n${session.page.ambiguous || 0} 条回复因无法确认是否为最终回复而未显示。\n“搜索对话”查找完整可读正文；“查找当前部分”仅搜索当前部分。\n${d.malformedRecords} 条格式损坏记录；${d.unparsedFinalRecord} 条未写完或损坏的末尾记录。源文件始终保持不变。`;
    if (elements.transcriptReadWarning) {
      const omitted = (d.oversizedRecords || 0) + (d.oversizedMessages || 0) + (d.malformedRecords || 0) + (d.unparsedFinalRecord || 0);
      elements.transcriptReadWarning.hidden = !session.page?.conversationOnly || !omitted;
      elements.transcriptReadWarning.textContent = elements.transcriptReadWarning.hidden ? '' :
        `部分内容未能读取：${d.oversizedRecords || 0} 条记录超出结构处理上限，${d.oversizedMessages || 0} 条记录的正文超出处理上限，${(d.malformedRecords || 0) + (d.unparsedFinalRecord || 0)} 条格式损坏或未写完的记录。其余内容可正常阅读，搜索结果可能不完整。`;
      if (!elements.transcriptReadWarning.hidden) diagnosticsText += '\n' + elements.transcriptReadWarning.textContent;
    }
    elements.directDiagnostics.textContent = diagnosticsText;
    elements.directDiagnostics.hidden = false;
    const isLarge = !session.page && (session.sourceBytes >= 512000 || messages.length >= 1000 ||
      messages.reduce((total, message) => total + message.text.length, 0) >= 512000);
    elements.largeSessionNotice.hidden = !isLarge;
    if (!isLarge) load();
  }
  function markStale() {
    elements.directDiagnostics.textContent = '重新读取失败，当前显示的内容可能不是最新。\n' + diagnosticsText;
  }
  return { clear, load, show, move, markStale,
    rename(name) { if (session) { session.name = name; elements.readTitle.textContent = name; } },
    getCwd: () => session?.cwd || showOptions.cwd || '',
    getReaderId: () => session?.page?.readerId,
    isFollowingLatest() {
      const container = elements.readMount.parentElement;
      return !!session?.page && !session.page.hasNext && !!container && container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    },
    revealMatch: revealMessageMatch, isActive: () => session !== null, isBusy: () => busy };
}
const api = { createDirectSessionView };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);
})();
