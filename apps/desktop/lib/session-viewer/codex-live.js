'use strict';
(function () {
function createCodexLive({ document: doc, elements: e, app, api, onOpen }) {
  let working = false, polling = false, pending = false, disposed = false, sourceKey = '', deferredSync = null;
  const clear = () => { while (e.results.firstChild) e.results.removeChild(e.results.firstChild); };
  const status = text => { e.status.textContent = text; };
  async function latest() {
    if (app.isBusy() || working) return;
    if (await app.showLatest()) { pending = false; e.latest.hidden = true; }
  }
  const identity = state => `${state.sourceMode}:${state.folder?.sourceId || ''}:${state.folder?.selectedSessionId || state.readerId || ''}`;
  async function applySync(result, key) {
    const state = app.getState();
    if (disposed || key !== identity(state)) return;
    if (app.isBusy()) { deferredSync = { result, key }; return; }
    if (!result?.ok) {
      if (!['in-progress', 'cancelled'].includes(result?.reason)) status('暂时无法自动更新，将稍后重试。');
      return;
    }
    if (result.catalog && result.catalog.generation < state.folder?.generation) return;
    if (result.changed) { app.syncCodexChanges(result); clear(); }
    if (result.bodyChanged) {
      pending = true;
      if (!working && app.isFollowingLatest() && await app.showLatest()) pending = false;
    }
    e.latest.hidden = !pending;
  }
  async function tick() {
    if (disposed) return;
    const state = app.getState(), active = state.sourceMode !== 'library';
    e.root.hidden = !active;
    const key = identity(state);
    if (key !== sourceKey) { if (deferredSync?.key !== key) deferredSync = null; clear(); pending = false; e.latest.hidden = true; sourceKey = key; status(''); }
    if (!active || polling || working || app.isBusy()) return;
    polling = true;
    try {
      if (deferredSync) {
        const saved = deferredSync; deferredSync = null;
        if (saved.key === key) { await applySync(saved.result, key); return; }
      }
      await applySync(await api.syncCodexConversation(), key);
    } catch { if (!disposed && !app.isBusy() && key === identity(app.getState())) status('暂时无法自动更新，将稍后重试。'); }
    finally { polling = false; }
  }
  async function search(query, scope, token) {
    query = String(query || '').trim();
    if (!query || query.length > 256 || working || app.isBusy()) return;
    const searchKey = app.getState ? identity(app.getState()) : null;
    if (searchKey !== null && searchKey !== sourceKey) {
      sourceKey = searchKey; deferredSync = null; pending = false; e.latest.hidden = true;
    }
    working = true; clear(); e.results.scrollTop = 0; status('正在搜索完整正文…'); e.cancel.hidden = false;
    if (e.submit) { e.submit.disabled = true; e.submit.textContent = '正在搜索…'; }
    const timer = api.codexSearchProgress && setInterval(async () => {
      try { const p = await api.codexSearchProgress(); if (working && !disposed && p?.searching) status(`已搜索 ${p.searched} / ${p.total} 个会话 · ${p.failed} 个暂不可读`); } catch {}
    }, 1000);
    try {
      const result = await (token ? api.moreCodexSearch(token) : api.searchCodexConversations(query, scope));
      if (disposed || (searchKey !== null && searchKey !== identity(app.getState()))) return;
      if (!result?.ok) { status(result?.reason === 'stale-result' ? '会话已变化，请重新搜索。' : '搜索未完成，请点击“搜索”重试。'); return; }
      status(`${result.hits.length ? `找到 ${result.hits.length} 条结果` : '没有找到匹配内容'} · 已搜索 ${result.searched}/${result.total} 个会话 · ${result.complete ? '搜索完成' : result.cancelled ? '已取消，仅显示部分结果' : result.hasMore ? '还有更多结果' : '搜索不完整'}${result.failed ? ` · ${result.failed} 个暂不可读` : ''}${result.partialConversations ? ` · ${result.partialConversations} 个会话有未读取内容` : ''}${result.truncated ? ' · 已达结果上限，请缩小搜索范围' : ''}`);
      if (result.shown > result.hits.length) status(e.status.textContent + ` · 已浏览 ${result.shown} 条`);
      for (const hit of result.hits) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'codex-search-hit';
        const title = doc.createElement('strong'); title.textContent = hit.title;
        const snippet = doc.createElement('span'); snippet.textContent = hit.snippet;
        button.appendChild(title); button.appendChild(snippet);
        button.addEventListener('click', async () => {
          if (working || app.isBusy()) return;
          working = true;
          try {
            const opened = await api.openCodexSearchHit(hit.hitId);
            if (opened?.ok) { app.showCodexSearchHit(opened); onOpen?.(); clear(); pending = false; e.latest.hidden = true; }
            else status('此结果已失效，请重新搜索。');
          } catch { status('暂时无法打开此结果，请重新搜索。'); }
          finally { working = false; }
        });
        e.results.appendChild(button);
      }
      if (result.nextToken) {
        const more = doc.createElement('button'); more.type = 'button'; more.className = 'codex-search-more';
        more.textContent = '下一页结果 →';
        more.addEventListener('click', () => { void search(query, scope, result.nextToken); });
        e.results.appendChild(more);
      }
    } catch { status('搜索未完成，请点击“搜索”重试。'); }
    finally { clearInterval(timer); working = false; e.cancel.hidden = true;
      if (e.submit) { e.submit.disabled = false; e.submit.textContent = '搜索'; } }
  }
  e.form.addEventListener('submit', event => { event.preventDefault(); void search(e.input.value, e.scope.value); });
  e.input.addEventListener('keydown', event => { if (event.key === 'Escape') { clear(); status(''); } });
  e.cancel.addEventListener('click', async () => {
    status('正在取消搜索…');
    try { await api.cancelCodexSearch(); } catch { status('暂时无法取消搜索，请稍后重试。'); }
  });
  e.latest.addEventListener('click', latest);
  return { tick, search, latest, dispose() { disposed = true; deferredSync = null; void api.cancelCodexSearch?.(); } };
}
const exported = { createCodexLive };
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, exported);
})();
