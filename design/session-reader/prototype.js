'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const icon = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const plain = html => { const node = document.createElement('div'); node.innerHTML = html; return node.textContent; };
  const data = structuredClone(window.prototypeFixtures);
  const state = { id: 'reader', source: 'all', favorites: false, theme: 'light', size: '中', width: '标准', follow: true,
    connected: { Codex: true, Claude: true }, scene: 'reader', older: 0, match: 0, timer: null };
  const current = () => data.find(item => item.id === state.id);
  const available = () => data.filter(item => state.connected[item.provider]);
  const badge = provider => `<span class="provider-mark ${provider === 'Claude' ? 'claude' : ''}">${provider === 'Claude' ? '✳' : 'C'}</span>`;
  let panel = '', restoreFocus = null, toastTimer;
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2400); }
  function showDialog(dialog) { restoreFocus = document.activeElement; dialog.showModal(); }
  function closeDialog(dialog) { dialog.close(); restoreFocus?.focus(); }
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', e => { if (e.target === dialog || e.target.closest('[data-close]')) closeDialog(dialog); });
    dialog.addEventListener('cancel', () => { restoreFocus?.focus(); });
  });
  function renderList() {
    const list = available().filter(item => (state.source === 'all' || state.source === item.provider) && (!state.favorites || item.favorite));
    let group = '';
    $('conversation-list').innerHTML = list.map(item => {
      const heading = item.date !== group ? `<div class="list-group">${escape(item.date)}</div>` : ''; group = item.date;
      return `${heading}<button class="session-item ${state.id === item.id ? 'active' : ''}" data-session="${item.id}" aria-current="${state.id === item.id ? 'true' : 'false'}"><div class="session-title"><span>${escape(item.title)}</span>${item.favorite ? icon('star') : ''}</div><div class="session-preview">${escape(item.preview)}</div><div class="session-meta">${badge(item.provider)} ${item.provider}<time>${item.time}</time></div></button>`;
    }).join('') || `<div class="list-empty">${state.favorites ? '还没有收藏的会话。<br>点击标题旁的星标，留住值得回看的对话。' : '这里还没有会话。<br>连接一个来源，就可以开始阅读。'}</div>`;
    $('list-heading').textContent = state.favorites ? '收藏的会话' : '最近会话';
    $('favorites-filter').setAttribute('aria-pressed', String(state.favorites));
    const connected = Object.values(state.connected).filter(Boolean).length;
    $('sources-button').innerHTML = `${connected ? '<span class="live-dot"></span>' : icon('folder')}<span>${connected} 个本地来源<small>仅显示活跃会话</small></span>${icon('chevron')}`;
    document.querySelectorAll('[data-source]').forEach(b => { b.classList.toggle('selected', b.dataset.source === state.source); b.setAttribute('aria-pressed', String(b.dataset.source === state.source)); });
  }
  function messageHtml(message, index) {
    return `<section class="message ${message.role}" data-message="${index}"><div class="message-label"><span class="avatar">${message.role === 'user' ? '你' : current()?.provider === 'Claude' ? '✳' : 'C'}</span><span>${message.role === 'user' ? '你' : current()?.provider || 'Codex'}</span><time>${message.time}</time></div><div class="message-body">${message.html}</div>${message.role === 'assistant' ? '<div class="message-actions"><button data-copy-message>复制回复</button></div>' : ''}</section>`;
  }
  function renderConversation(latest = true) {
    const item = current();
    $('conversation-title').textContent = item.title;
    $('conversation-meta').innerHTML = `${badge(item.provider)}<span>${item.provider}</span><span>·</span><span>${escape(item.project)}</span><span>·</span><span>${item.date} ${item.time}</span>`;
    $('favorite-button').setAttribute('aria-pressed', String(item.favorite));
    $('favorite-button').setAttribute('aria-label', item.favorite ? '取消收藏' : '收藏会话');
    document.querySelector('.header-actions').hidden = false;
    $('sync-status').innerHTML = '<span class="live-dot"></span> 自动同步<span class="footer-dot">·</span>只读';
    $('notice').hidden = true;
    const earlier = Array.from({ length: state.older }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', time: `09:${String(10 + n).padStart(2, '0')}`,
      html: n % 2 ? '<p>可以先做一个小而完整的版本：把找到会话、打开最新回复、回看历史这三件事串起来，再逐步补齐体验。</p>' : '<p>我们先把这一部分的边界说明白，再继续下一步。每一步都应该有可见、可验证的结果。</p>' }));
    $('transcript').innerHTML = `${state.older < 40 ? '<button class="older-button" data-older>↑ 查看更早的消息</button>' : '<div class="history-badge">已到会话开头</div>'}<div class="day-divider">${item.date}的对话</div>` + [...earlier, ...item.messages].map(messageHtml).join('');
    if (latest) goLatest(); else updatePosition();
  }
  function openConversation(id) {
    clearTimeout(state.timer); state.id = id; state.scene = 'reader'; state.older = 0;
    $('find-bar').hidden = true; $('find-input').value = ''; renderList(); renderConversation();
  }
  function goLatest() { const scroller = $('reading-scroll'); scroller.scrollTop = scroller.scrollHeight; updatePosition(); }
  function updatePosition() {
    if (state.scene === 'empty' || state.scene === 'loading') {
      $('jump-latest').hidden = true;
      $('reader-position').textContent = state.scene === 'loading' ? '正在加载' : available().length ? '请选择一段对话' : '等待连接来源';
      return;
    }
    const scroller = $('reading-scroll'), latest = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 45;
    $('jump-latest').hidden = latest || !['reader', 'partial', 'long', 'offline'].includes(state.scene);
    $('reader-position').textContent = latest ? '已到最新' : '正在回看历史';
  }
  function showFind() { if (!current() || state.scene === 'empty') return; $('find-bar').hidden = false; $('find-input').focus(); }
  function clearHighlights() { $('transcript').querySelectorAll('mark').forEach(node => node.replaceWith(document.createTextNode(node.textContent))); $('transcript').normalize(); }
  function findText() {
    clearHighlights(); state.match = 0;
    const query = $('find-input').value.trim().toLocaleLowerCase();
    if (query) $('transcript').querySelectorAll('.message-body').forEach(body => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), nodes = []; let node;
      while ((node = walker.nextNode())) if (!node.parentElement.closest('button')) nodes.push(node);
      for (const textNode of nodes) {
        const text = textNode.textContent, lower = text.toLocaleLowerCase(), fragment = document.createDocumentFragment(); let start = 0, index;
        while ((index = lower.indexOf(query, start)) >= 0) {
          fragment.append(text.slice(start, index)); const mark = document.createElement('mark'); mark.textContent = text.slice(index, index + query.length); fragment.append(mark); start = index + query.length;
        }
        if (start) { fragment.append(text.slice(start)); textNode.replaceWith(fragment); }
      }
    });
    moveMatch(0);
  }
  function moveMatch(delta) {
    const marks = [...$('transcript').querySelectorAll('mark')];
    state.match = marks.length ? (state.match + delta + marks.length) % marks.length : 0;
    marks.forEach((mark, n) => mark.classList.toggle('current', n === state.match));
    $('find-count').textContent = $('find-input').value ? marks.length ? `${state.match + 1} / ${marks.length}` : '没有匹配' : '';
    $('find-previous').disabled = $('find-next').disabled = !marks.length;
    marks[state.match]?.scrollIntoView({ block: 'center' });
  }
  function searchResults() {
    const query = $('search-input').value.trim(), lower = query.toLocaleLowerCase();
    const list = available().filter(item => !lower || `${item.title} ${item.messages.map(m => plain(m.html)).join(' ')}`.toLocaleLowerCase().includes(lower));
    $('search-title').textContent = query ? `“${query}” 的搜索结果` : '最近打开';
    $('search-result-count').textContent = `${list.length} 个会话`;
    $('search-results').innerHTML = list.map(item => {
      const text = item.messages.map(m => plain(m.html)).join(' '), at = text.toLocaleLowerCase().indexOf(lower);
      let snippet = query && at >= 0 ? text.slice(Math.max(0, at - 22), at + 95) : item.preview;
      snippet = escape(snippet);
      if (query) { const literal = escape(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); snippet = snippet.replace(new RegExp(literal, 'gi'), '<mark>$&</mark>'); }
      return `<button class="search-result" data-result="${item.id}"><div class="search-result-heading">${badge(item.provider)}<span>${escape(item.title)}</span><small>${item.date}</small></div><p>${snippet}</p></button>`;
    }).join('') || '<div class="no-results"><strong>没有找到这句话</strong>试试更短的关键词，或者搜索会话名称。</div>';
  }
  function openSearch() { $('search-input').value = ''; searchResults(); showDialog($('search-dialog')); $('search-input').focus(); }
  function chooseResult(id) { const query = $('search-input').value; closeDialog($('search-dialog')); openConversation(id); if (query) { showFind(); $('find-input').value = query; findText(); } }
  function setTheme(theme) {
    state.theme = theme; document.documentElement.dataset.theme = theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : theme;
  }
  const pressed = value => String(value);
  function settingsHtml() {
    return `<section class="settings-section"><h3>外观</h3><div class="theme-options">${[['light','sun','浅色'],['dark','moon','深色'],['system','monitor','跟随系统']].map(([value,i,label]) => `<button class="theme-option" data-theme="${value}" aria-pressed="${pressed(state.theme === value)}">${icon(i)} ${label}</button>`).join('')}</div></section><section class="settings-section"><h3>阅读</h3><div class="setting-row"><span>正文字号</span><div class="segmented">${['小','中','大'].map(s => `<button data-size="${s}" aria-pressed="${pressed(state.size === s)}">${s}</button>`).join('')}</div></div><div class="setting-row"><span>阅读宽度</span><div class="segmented">${['紧凑','标准','宽松'].map(s => `<button data-width="${s}" aria-pressed="${pressed(state.width === s)}">${s}</button>`).join('')}</div></div><div class="setting-row"><span>跟随最新消息<small>回看历史时，不打断当前位置</small></span><button class="toggle" data-follow role="switch" aria-label="跟随最新消息" aria-checked="${state.follow}"></button></div></section><section class="settings-section"><h3>数据与隐私</h3><div class="setting-row"><span>聊天来源</span><button class="text-link" data-panel="sources">管理来源 →</button></div><p class="privacy-note">此原型只使用内置的虚构内容。所有设置只影响当前预览，关闭后恢复默认，不会读取或改动你的聊天文件。</p></section>`;
  }
  function sourcesHtml() {
    return `<p class="panel-intro">将对话留在自己的电脑上。连接后，活跃会话与名称会自动更新，原始记录始终只读。</p>${['Codex','Claude'].map(provider => `<section class="source-card"><div class="source-card-heading">${badge(provider)}${provider === 'Claude' ? 'Claude Code' : 'Codex'}<span>${state.connected[provider] ? '● 已连接' : '未连接'}</span></div><p>~/示例来源/${provider.toLowerCase()}</p><div class="source-actions">${state.connected[provider] ? `<button data-sync="${provider}">重新检查</button><button data-disconnect="${provider}">断开来源</button>` : `<button data-connect="${provider}">连接示例来源</button>`}</div></section>`).join('')}<p class="privacy-note">这里演示来源管理的界面，不会打开真实文件夹，也不会删除任何聊天。Claude 支持在此处仅为原型演示。</p>`;
  }
  function detailsHtml() {
    const item = current();
    return `<p class="details-title">${escape(item.title)}</p>${[['来源',item.provider],['项目',item.project],['状态','活跃会话'],['最近更新',`${item.date} ${item.time}`],['显示内容','你的提示词 · 最终回复'],['读取方式','本地 · 只读']].map(([k,v]) => `<div class="detail-row"><span>${k}</span><span>${escape(v)}</span></div>`).join('')}<p class="privacy-note">归档、重命名在原来的 CLI 中完成。这里同步显示结果，不修改源文件。</p><details ${state.scene === 'partial' ? 'open' : ''}><summary class="text-link">查看读取详情</summary><p class="privacy-note">${state.scene === 'partial' ? '演示状态：1 条超长记录已省略，搜索范围不完整。其余内容仍可阅读，原文件未修改。' : '演示状态：后台审核已隐藏，正文可正常阅读。正式版的异常计数会在这里提供，不占据主界面。'}</p></details>`;
  }
  function scenariosHtml() {
    return '<p class="panel-intro">体验同一套界面在不同情境下的样子。所有操作仅影响虚构示例。</p><div class="scenario-grid">' + [
      ['reader','日常阅读','提示词、Markdown 与代码'], ['long','长会话','回看历史与跳转最新'],
      ['empty','首次打开','还没有连接来源'], ['loading','正在加载','稳定的骨架与加载反馈'],
      ['offline','来源暂不可用','保留当前阅读内容'], ['partial','部分内容不可读','克制、明确的异常提示'],
      ['rename','名称同步','列表与正文同步更新'], ['new','新消息到达','尊重当前阅读位置'],
      ['reset','重置演示','恢复初始数据与外观'],
    ].map(([value,label,detail]) => `<button class="scenario-card" data-scene="${value}">${label}<small>${detail}</small></button>`).join('') + '</div>';
  }
  function showPanel(name, reopen = true) {
    panel = name; $('panel-dialog').classList.toggle('sheet', name === 'details');
    $('panel-title').textContent = { settings:'设置',sources:'聊天来源',details:'会话信息',scenarios:'原型场景' }[name];
    $('panel-content').className = 'panel-content';
    $('panel-content').innerHTML = { settings:settingsHtml,sources:sourcesHtml,details:detailsHtml,scenarios:scenariosHtml }[name]();
    if (reopen && !$('panel-dialog').open) showDialog($('panel-dialog'));
  }
  function emptyState() {
    $('find-bar').hidden = true; $('find-input').value = ''; $('find-count').textContent = '';
    $('conversation-title').textContent = '你的对话，从这里开始'; $('conversation-meta').textContent = '一个安静的地方，回看那些有用的话。';
    document.querySelector('.header-actions').hidden = true; $('notice').hidden = true;
    $('transcript').innerHTML = `<div class="empty-state"><div class="empty-illustration">${icon('book')}</div><h2>让对话有个归处</h2><p>连接 Codex 或 Claude Code 的聊天来源。<br>之后，找到一句话、接上一段思路，就简单了。</p><button class="primary" data-panel="sources">连接聊天来源</button><p class="privacy-note">本地阅读 · 原始记录保持不变</p></div>`;
    $('jump-latest').hidden = true; $('reader-position').textContent = '等待连接来源';
    $('sync-status').textContent = '仅本地读取 · 只读';
    if (available().length) {
      $('conversation-title').textContent = '选择一段对话';
      $('transcript').innerHTML = `<div class="empty-state"><div class="empty-illustration">${icon('book')}</div><h2>继续一段熟悉的思路</h2><p>刚才的来源已断开。<br>你仍可以从左侧打开其他来源的会话。</p></div>`;
    }
    updatePosition();
  }
  function scenario(name) {
    closeDialog($('panel-dialog')); clearTimeout(state.timer); $('find-bar').hidden = true;
    if (name === 'reset') { location.reload(); return; }
    if (name === 'rename') {
      current().title = current().title.endsWith(' · 新名称') ? current().title.slice(0, -6) : current().title + ' · 新名称';
      renderList(); $('conversation-title').textContent = current().title; toast('名称已同步，阅读位置保持不变'); return;
    }
    state.connected = { Codex:true, Claude:true }; state.id = 'reader'; state.source = 'all'; state.favorites = false; state.older = 0; state.scene = name;
    if (name === 'empty') { state.connected = { Codex:false, Claude:false }; renderList(); emptyState(); return; }
    renderList(); renderConversation(!['long', 'new'].includes(name));
    if (name === 'long') { state.older = 24; renderConversation(false); $('reading-scroll').scrollTop = 0; updatePosition(); }
    if (name === 'loading') {
      $('transcript').innerHTML = '<div class="loading-label"><span class="spinner"></span>正在打开会话…</div><div class="skeleton skeleton-title"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton-space"></div><div class="skeleton skeleton-title"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div>';
      state.timer = setTimeout(() => { state.scene = 'reader'; renderConversation(); }, 2200);
    }
    if (name === 'offline') { $('notice').hidden = false; $('notice').innerHTML = '暂时无法连接聊天来源，当前内容仍可阅读。 <button data-retry>重试</button> <button data-panel="sources">管理来源</button>'; $('sync-status').textContent = '同步已暂停 · 只读'; }
    if (name === 'partial') { $('notice').hidden = false; $('notice').innerHTML = '有少量内容暂时无法显示，其余对话仍可阅读。 <button data-panel="details">查看详情</button>'; }
    if (name === 'new') {
      state.scene = 'reader'; $('reading-scroll').scrollTop = 0;
      if (!current().messages.some(m => m.newMessage)) current().messages.push({ role:'assistant',time:'10:45',newMessage:true,html:'<p>补充一点：当你回看历史时，新消息会安静地等在底部。阅读位置属于你，不应该被自动更新打断。</p>' });
      renderConversation(false);
      $('reading-scroll').scrollTop = 0; $('jump-latest').hidden = false;
      $('jump-latest').querySelector('span').textContent = '有新回复 · 回到最新'; $('reader-position').textContent = '正在回看历史';
    }
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('已复制'); }
    catch { toast('浏览器未允许复制，请直接选中文字复制'); }
  }
  $('conversation-list').addEventListener('click', e => { const row = e.target.closest('[data-session]'); if (row) openConversation(row.dataset.session); });
  document.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => { state.source = button.dataset.source; renderList(); }));
  $('favorites-filter').addEventListener('click', () => { state.favorites = !state.favorites; renderList(); });
  $('favorite-button').addEventListener('click', () => { current().favorite = !current().favorite; $('favorite-button').setAttribute('aria-pressed', String(current().favorite)); $('favorite-button').setAttribute('aria-label', current().favorite ? '取消收藏' : '收藏会话'); renderList(); toast(current().favorite ? '已加入收藏' : '已取消收藏'); });
  $('global-search').addEventListener('click', openSearch); $('search-input').addEventListener('input', searchResults);
  $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const first = $('search-results').querySelector('[data-result]'); if (first) chooseResult(first.dataset.result); } });
  $('search-results').addEventListener('click', e => { const result = e.target.closest('[data-result]'); if (result) chooseResult(result.dataset.result); });
  $('find-button').addEventListener('click', showFind); $('find-input').addEventListener('input', findText);
  $('find-next').addEventListener('click', () => moveMatch(1)); $('find-previous').addEventListener('click', () => moveMatch(-1));
  $('find-close').addEventListener('click', () => { $('find-bar').hidden = true; clearHighlights(); $('find-button').focus(); });
  $('reading-scroll').addEventListener('scroll', updatePosition, { passive:true }); $('jump-latest').addEventListener('click', () => { goLatest(); $('jump-latest').querySelector('span').textContent = '回到最新消息'; });
  $('settings-button').addEventListener('click', () => showPanel('settings')); $('sources-button').addEventListener('click', () => showPanel('sources'));
  $('details-button').addEventListener('click', () => showPanel('details')); $('scenarios-button').addEventListener('click', () => showPanel('scenarios'));
  document.addEventListener('click', e => {
    const button = e.target.closest('button'); if (!button) return;
    if (button.dataset.panel) showPanel(button.dataset.panel);
    if (button.dataset.scene) scenario(button.dataset.scene);
    if (button.dataset.theme) { setTheme(button.dataset.theme); showPanel('settings', false); $('panel-content').querySelector(`[data-theme="${state.theme}"]`).focus(); }
    if (button.dataset.size) { state.size = button.dataset.size; document.documentElement.style.setProperty('--body-size', { 小:'14px',中:'16px',大:'18px' }[state.size]); showPanel('settings', false); }
    if (button.dataset.width) { state.width = button.dataset.width; document.documentElement.style.setProperty('--reading-width', { 紧凑:'620px',标准:'720px',宽松:'850px' }[state.width]); showPanel('settings', false); }
    if (button.hasAttribute('data-follow')) { state.follow = !state.follow; button.setAttribute('aria-checked', String(state.follow)); }
    if (button.dataset.disconnect) { state.connected[button.dataset.disconnect] = false; renderList(); if (!state.connected[current().provider]) { state.scene = 'empty'; emptyState(); } showPanel('sources', false); }
    if (button.dataset.connect) { state.connected[button.dataset.connect] = true; renderList(); openConversation(available().find(i => i.provider === button.dataset.connect).id); closeDialog($('panel-dialog')); toast('示例来源已连接'); }
    if (button.dataset.sync) toast('示例来源已是最新');
    if (button.hasAttribute('data-retry')) { $('notice').hidden = true; state.scene = 'reader'; $('sync-status').innerHTML = '<span class="live-dot"></span> 自动同步<span class="footer-dot">·</span>只读'; toast('示例来源已恢复连接'); }
    if (button.hasAttribute('data-older')) {
      const scroller = $('reading-scroll'), height = scroller.scrollHeight, top = scroller.scrollTop;
      state.older = Math.min(40, state.older + 8); state.scene = 'reader'; renderConversation(false); scroller.scrollTop = scroller.scrollHeight - height + top; toast('已加载更早的示例消息');
    }
    if (button.hasAttribute('data-copy-code')) copyText(button.closest('.code-block').querySelector('code').textContent);
    if (button.hasAttribute('data-copy-message')) copyText(button.closest('.message').querySelector('.message-body').textContent);
  });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('panel-dialog').open) closeDialog($('panel-dialog')); if (!$('search-dialog').open) openSearch(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !document.querySelector('dialog[open]')) { e.preventDefault(); showFind(); }
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { $('find-bar').hidden = true; clearHighlights(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'system') setTheme('system'); });
  setTheme('light'); renderList(); renderConversation();
})();
