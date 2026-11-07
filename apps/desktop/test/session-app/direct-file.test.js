'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionApp } = require('../../lib/session-app');
const { makeFakeDocument, flattenText, findAllByTag } = require('../session-viewer/read-fake-document');
const { renderStructuredConversation } = require('../../lib/session-viewer/structured-conversation');
function harness() {
  const document = makeFakeDocument();
  const createElement = document.createElement;
  document.createElement = tag => {
    const element = createElement(tag);
    element.listeners = {};
    element.addEventListener = (type, handler) => { element.listeners[type] = handler; };
    element.click = () => element.listeners.click();
    return element;
  };
  const elements = {};
  for (const name of ['chooseLibraryButton', 'openCodexFileButton', 'reloadCodexFileButton', 'backToLibraryButton', 'directDiagnostics', 'librarySearch', 'refreshButton', 'libraryPath', 'status', 'statusRetry', 'libraryWarning', 'refreshResult', 'sessionList', 'globalSearchInput', 'globalSearchResults', 'globalSearchBanner', 'readTitle', 'readMount', 'inFileSearchToolbar', 'inFileSearchInput', 'inFileSearchPrev', 'inFileSearchNext', 'inFileSearchCounter', 'largeSessionNotice', 'loadLargeSessionButton', 'emptyState']) {
    elements[name] = Object.assign(document.createElement('div'), { dataset: {}, value: '', hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  }
  const calls = { imports: 0, rendered: 0, active: false, resets: 0 };
  for (const name of ['transcriptReadWarning', 'transcriptPager', 'transcriptPageStatus', 'transcriptPrevious', 'transcriptNext', 'transcriptCancel']) {
    elements[name] = document.createElement('div');
  }
  const session = { name: 'rollout-synthetic.jsonl', sourceBytes: 120, conversation: {
    messages: [{ role: 'user', text: '## Assistant\nLiteral heading' }, { role: 'assistant', text: '### Tool use: literal\nVisible needle' }],
    diagnostics: { malformedRecords: 1, unparsedFinalRecord: 1, unsupportedRecords: 2, omittedContentBlocks: 3, excludedRecords: 4 },
  } };
  const api = {
    loadSessions: async () => ({ ok: true, libraryPath: '/synthetic/library', sessions: [{ id: 'old', body: 'old' }] }),
    chooseLibrary: async () => ({ ok: false, reason: 'cancelled' }),
    chooseCodexFile: async () => ({ ok: true, session }),
    reloadCodexFile: async () => ({ ok: true, session }),
    refreshSessions: async () => { calls.imports++; },
  };
  const viewer = {
    createFavoritesController: () => ({ isFavorite: () => false, toggle() {} }),
    createInFileSearchToolbar: () => ({ onReadActivated() { calls.active = true; }, onReadDeactivated() { calls.active = false; calls.resets++; }, refreshAfterRender() {}, searchAndReveal() {} }),
    createGroupedListRenderer: () => ({ render() {} }), groupAndSort: () => ({}),
    renderStructuredConversation(...args) { calls.rendered++; return renderStructuredConversation(...args); },
    MIN_GLOBAL_QUERY_LEN: 2, renderGlobalResults() {},
  };
  const app = createSessionApp({ document, elements, sessionApi: api, sessionViewer: viewer });
  return { app, api, elements, session, calls, document, viewer };
}
test('conversation view opens at the bottom, but historical page navigation starts at the top', async () => {
  const h = harness();
  const parent = h.document.createElement('div'); parent.scrollHeight = 1000; parent.clientHeight = 200;
  parent.appendChild(h.elements.readMount);
  h.elements.readMount.parentElement = parent;
  h.session.page = { readerId: 'synthetic', number: 4, pages: 4, latest: true, conversationOnly: true, hasPrevious: true, hasNext: false };
  await h.app.chooseCodexFile();
  assert.equal(parent.scrollTop, 1000);
  h.session.page.latest = false;
  await h.app.reloadCodexFile();
  assert.equal(parent.scrollTop, 0);
});
test('clearing an archived selection removes its body and title without changing the source empty state', () => {
  const h = harness();
  const { createDirectSessionView } = require('../../lib/session-viewer/direct-session');
  const view = createDirectSessionView({ elements: h.elements, viewer: h.viewer, document: h.document,
    inFileSearch: { onReadActivated() {}, onReadDeactivated() {}, refreshAfterRender() {} } });
  view.show(h.session, { cwd: '/synthetic/previous-project' }); assert.ok(h.elements.readMount.children.length);
  assert.equal(view.getCwd(), '/synthetic/previous-project');
  h.elements.emptyState.hidden = true;
  view.clear();
  assert.equal(h.elements.readMount.children.length, 0);
  assert.equal(h.elements.readTitle.textContent, '');
  assert.equal(view.getCwd(), '');
  assert.equal(h.elements.emptyState.hidden, true);
});
test('direct opening renders structured roles, diagnostics and read-only controls; returning restores library', async () => {
  const h = harness();
  await h.app.initialize();
  assert.equal(await h.app.chooseCodexFile(), true);
  assert.equal(h.app.getState().sourceMode, 'codex');
  assert.equal(h.elements.refreshButton.disabled, true);
  assert.equal(h.elements.librarySearch.hidden, true);
  assert.equal(h.elements.sessionList.hidden, true);
  assert.equal(h.elements.reloadCodexFileButton.hidden, false);
  assert.match(flattenText(h.elements.readMount), /Literal heading.*Visible needle/s);
  assert.equal(h.elements.readMount.children.length, 2);
  assert.match(h.elements.directDiagnostics.textContent, /2 条消息/);
  assert.match(h.elements.directDiagnostics.textContent, /3 个未显示的内容块/);
  assert.equal(flattenText(h.elements.readMount).includes('未显示的内容块'), false);
  assert.equal(h.calls.active, true);
  assert.deepEqual(await h.app.searchAll('needle'), []);
  assert.equal(await h.app.refreshSessions(), false);
  assert.equal(h.calls.imports, 0);
  assert.equal(await h.app.backToLibrary(), true);
  assert.equal(h.app.getState().sourceMode, 'library');
  assert.equal(h.elements.librarySearch.hidden, false);
  assert.equal(h.elements.refreshButton.disabled, false);
  assert.equal(h.elements.directDiagnostics.hidden, true);
});
test('cancel/failure retains snapshot; failed Reload labels stale and successful Reload clears it', async () => {
  const h = harness();
  await h.app.chooseCodexFile();
  h.api.chooseCodexFile = async () => ({ ok: false, reason: 'cancelled' });
  assert.equal(await h.app.chooseCodexFile(), false);
  h.api.reloadCodexFile = async () => { throw new Error('/secret/path'); };
  assert.equal(await h.app.reloadCodexFile(), false);
  assert.match(h.elements.status.textContent, /不是最新|可能不是最新/);
  assert.equal(h.elements.status.textContent.includes('secret'), false);
  assert.match(flattenText(h.elements.readMount), /Visible needle/);
  h.api.loadSessions = async () => ({ ok: false, reason: 'invalid-library' });
  assert.equal(await h.app.backToLibrary(), false);
  assert.equal(h.app.getState().sourceMode, 'codex');
  assert.match(h.elements.directDiagnostics.textContent, /重新读取失败/);
  h.api.reloadCodexFile = async () => ({ ok: true, session: h.session });
  assert.equal(await h.app.reloadCodexFile(), true);
  assert.doesNotMatch(h.elements.status.textContent, /不是最新|可能不是最新/);
  h.api.loadSessions = async () => ({ ok: false, reason: 'no-library' });
  await h.app.backToLibrary();
  assert.equal(h.app.getState().sourceMode, 'library');
});
test('large input, aggregate text and message count defer rendering on every accepted Reload', async () => {
  for (const mutate of [s => { s.sourceBytes = 512000; }, s => { s.conversation.messages = [{ role: 'user', text: 'x'.repeat(512000) }]; }, s => { s.conversation.messages = Array.from({ length: 1000 }, () => ({ role: 'user', text: 'x' })); }]) {
    const h = harness(); mutate(h.session);
    await h.app.chooseCodexFile();
    assert.equal(h.calls.rendered, 0);
    assert.equal(h.calls.active, false);
    assert.equal(h.elements.largeSessionNotice.hidden, false);
    assert.equal(h.app.loadSelectedLargeSession(), true);
    assert.equal(h.calls.rendered, 1);
    assert.equal(h.calls.active, true);
    await h.app.reloadCodexFile();
    assert.equal(h.calls.rendered, 1);
    assert.equal(h.elements.readMount.children.length, 0);
    assert.equal(h.calls.active, false);
  }
});
test('empty supported text has an explicit state and source requests cannot overlap', async () => {
  const h = harness(); h.session.conversation.messages = [];
  let finish;
  h.api.chooseCodexFile = () => new Promise(resolve => { finish = resolve; });
  const pending = h.app.chooseCodexFile();
  assert.equal(h.elements.chooseLibraryButton.disabled, true);
  assert.equal(await h.app.chooseLibrary(), false);
  assert.equal(await h.app.chooseCodexFile(), false);
  assert.equal(await h.app.reloadCodexFile(), false);
  finish({ ok: true, session: h.session });
  await pending;
  assert.match(h.elements.directDiagnostics.textContent, /没有可显示的对话正文/);
  assert.equal(h.elements.openCodexFileButton.disabled, false);
});
test('late library indexing and result callbacks cannot restore a previous source', async () => {
  const h = harness(); let finish, click;
  h.viewer.loadGlobalIndex = () => new Promise(resolve => { finish = resolve; });
  h.viewer.searchIndex = () => [{ id: 'old' }];
  h.viewer.renderGlobalResults = (_mount, _results, _doc, callback) => { click = callback; };
  await h.app.initialize();
  const indexing = h.app.searchAll('needle');
  await h.app.chooseCodexFile(); finish();
  assert.deepEqual(await indexing, []);
  assert.equal(click, undefined);
  assert.equal(h.app.selectSession('old'), false);
  assert.equal(h.app.getState().sourceMode, 'codex');
});

test('direct message previews reset on successful Reload, survive failed Reload, and remain behind large-session confirmation', async () => {
  const h = harness();
  h.session.conversation.messages = [{ role: 'user', text: 'Long synthetic body '.repeat(60) }];
  await h.app.chooseCodexFile();
  const buttons = () => findAllByTag(h.elements.readMount, 'button');
  assert.equal(buttons().length, 1);
  buttons()[0].click();
  assert.equal(buttons()[0].getAttribute('aria-expanded'), 'true');
  h.api.reloadCodexFile = async () => ({ ok: false, reason: 'invalid-file' });
  await h.app.reloadCodexFile();
  assert.equal(buttons()[0].getAttribute('aria-expanded'), 'true');
  h.api.reloadCodexFile = async () => ({ ok: true, session: h.session });
  await h.app.reloadCodexFile();
  assert.equal(buttons()[0].getAttribute('aria-expanded'), 'false');
  h.session.sourceBytes = 512000;
  await h.app.reloadCodexFile();
  assert.equal(buttons().length, 0);
  h.app.loadSelectedLargeSession();
  assert.equal(buttons().length, 1);
  assert.equal(buttons()[0].getAttribute('aria-expanded'), 'false');
  await h.app.backToLibrary();
  assert.equal(buttons().length, 0);
});

test('paged sources render a bounded segment immediately, replace DOM on next and label search scope', async () => {
  const h = harness();
  h.session.sourceBytes = 200 * 1024 * 1024;
  h.session.page = { readerId: 'opaque', number: 1, hasNext: true, hasPrevious: false, scannedBytes: 100, totalBytes: h.session.sourceBytes };
  await h.app.chooseCodexFile();
  assert.equal(h.calls.rendered, 1);
  assert.equal(h.elements.transcriptPager.hidden, false);
  assert.equal(h.elements.transcriptPrevious.disabled, true);
  assert.equal(h.elements.inFileSearchInput.placeholder, '查找当前部分…');
  let finish;
  h.api.moveCodexPage = (id, direction) => {
    assert.equal(id, 'opaque'); assert.equal(direction, 'next');
    return new Promise(resolve => { finish = resolve; });
  };
  const pending = h.elements.transcriptNext.listeners.click();
  assert.equal(h.elements.openCodexFileButton.disabled, true);
  assert.equal(h.elements.transcriptCancel.hidden, false);
  finish({ ok: true, session: { ...h.session, page: { ...h.session.page, number: 2, hasPrevious: true, hasNext: false },
    conversation: { ...h.session.conversation, messages: [{ role: 'assistant', text: 'second segment' }] } } });
  await pending;
  assert.match(flattenText(h.elements.readMount), /second segment/);
  assert.doesNotMatch(flattenText(h.elements.readMount), /Literal heading/);
  assert.equal(h.elements.transcriptNext.disabled, true);
  assert.equal(h.elements.openCodexFileButton.disabled, false);
  await h.app.backToLibrary();
  assert.equal(h.elements.transcriptPager.hidden, true);
  assert.equal(h.elements.inFileSearchInput.placeholder, '查找当前会话…');
});

test('failed page navigation keeps content and clearly requests Reload for a changed source', async () => {
  const h = harness();
  h.session.page = { readerId: 'opaque', number: 1, hasNext: true, hasPrevious: false, scannedBytes: 20, totalBytes: 200 };
  await h.app.chooseCodexFile();
  h.api.moveCodexPage = async () => ({ ok: false, reason: 'source-changed' });
  await h.elements.transcriptNext.listeners.click();
  assert.match(flattenText(h.elements.readMount), /Visible needle/);
  assert.match(h.elements.status.textContent, /重新读取/);
  assert.equal(h.elements.transcriptNext.disabled, false);
});

test('bounded-record errors explain the limit instead of blaming the selected filename', async () => {
  const h = harness();
  for (const [reason, detail] of [['record-too-large', /结构处理上限/], ['message-too-large', /安全读取预算/]]) {
    h.api.chooseCodexFile = async () => ({ ok: false, reason });
    await h.app.chooseCodexFile();
    assert.match(h.elements.status.textContent, detail);
  }
});

test('an empty metadata-only segment gives a visible reading state and retains Next', async () => {
  const h = harness();
  h.session.conversation.messages = [];
  h.session.page = { readerId: 'opaque', number: 1, hasNext: true, scannedBytes: 4000, totalBytes: 9000 };
  await h.app.chooseCodexFile();
  assert.match(flattenText(h.elements.readMount), /这部分没有可显示的提示词或最终回复/);
  assert.equal(h.elements.transcriptNext.disabled, false);
});

test('compressed segments label their scope without inventing a scanned percentage', async () => {
  const h = harness();
  h.session.page = { readerId: '11111111-1111-4111-8111-111111111111', number: 2,
    hasNext: true, hasPrevious: true, compressed: true, scannedBytes: 900000, totalBytes: null };
  await h.app.initialize();
  await h.app.chooseCodexFile();
  assert.match(h.elements.transcriptPageStatus.textContent, /压缩记录/);
  assert.doesNotMatch(h.elements.transcriptPageStatus.textContent, /%|NaN/);
  h.api.moveCodexPage = async () => ({ ok: false, reason: 'decompression-failed' });
  await h.elements.transcriptNext.click();
  assert.match(h.elements.status.textContent, /压缩记录损坏/i);
});
test('latest scroll happens after search toolbar changes the available reader height', () => {
  const h = harness(), container = { scrollHeight: 1000, clientHeight: 300 };
  let top = 0;
  Object.defineProperty(container, 'scrollTop', { get: () => top, set: n => { top = Math.min(n, container.scrollHeight - container.clientHeight); } });
  h.elements.readMount.parentElement = container;
  h.session.page = { latest: true, number: 1, pages: 1, conversationOnly: true };
  const { createDirectSessionView } = require('../../lib/session-viewer/direct-session');
  const view = createDirectSessionView({ elements: h.elements, viewer: h.viewer, document: h.document,
    inFileSearch: { onReadDeactivated() {}, onReadActivated() { container.clientHeight = 250; }, refreshAfterRender() {} } });
  view.show(h.session);
  assert.equal(container.scrollTop, 750);
});
test('conversation search bar is visible before first body render, without waiting for a poll', async () => {
  const h = harness();
  h.elements.codexLive = { hidden: true };
  const render = h.viewer.renderStructuredConversation;
  h.viewer.renderStructuredConversation = (...args) => {
    assert.equal(h.elements.codexLive.hidden, false); return render(...args);
  };
  assert.equal(await h.app.chooseCodexFile(), true);
  await h.app.backToLibrary(); assert.equal(h.elements.codexLive.hidden, true);
});

test('omitted content warning remains outside the scrolling transcript and clears on clean loads', async () => {
  const h = harness();
  h.session.page = { readerId: 'synthetic', number: 1, pages: 1, latest: true, conversationOnly: true };
  Object.assign(h.session.conversation.diagnostics, { malformedRecords: 0, unparsedFinalRecord: 0, oversizedRecords: 2, oversizedMessages: 1 });
  await h.app.chooseCodexFile();
  assert.equal(h.elements.transcriptReadWarning.hidden, false);
  assert.match(h.elements.transcriptReadWarning.textContent, /2 条记录超出结构处理上限.*1 条记录的正文超出处理上限/);
  assert.match(h.elements.transcriptReadWarning.textContent, /搜索结果可能不完整/);
  Object.assign(h.session.conversation.diagnostics, { oversizedRecords: 0, oversizedMessages: 0 });
  await h.app.reloadCodexFile();
  assert.equal(h.elements.transcriptReadWarning.hidden, true);
  await h.app.backToLibrary();
  assert.equal(h.elements.transcriptReadWarning.textContent, '');
});


test('changed source offers reload retry and clears the recovery action on success', async () => {
  const h = harness(); let reloads = 0;
  h.session.page = { readerId: 'opaque', number: 1, pages: 2, conversationOnly: true, hasNext: true };
  await h.app.chooseCodexFile();
  h.api.moveCodexPage = async () => ({ ok: false, reason: 'source-changed' });
  h.api.reloadCodexFile = async () => { reloads++; return { ok: true, session: h.session }; };
  await h.elements.transcriptNext.listeners.click();
  assert.equal(h.elements.statusRetry.hidden, false);
  assert.match(flattenText(h.elements.readMount), /Visible needle/);
  await h.elements.statusRetry.listeners.click();
  assert.equal(reloads, 1);
  assert.equal(h.elements.statusRetry.hidden, true);
  assert.match(h.elements.transcriptPageStatus.textContent, /第 1 \/ 2 部分/);
});

test('directional navigation lands at the shared boundary and first/latest remain explicit', async () => {
  const h = harness(); const parent = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
  h.elements.readMount.parentElement = parent;
  h.session.page = { readerId: 'synthetic', number: 3, pages: 3, latest: true, conversationOnly: true, hasPrevious: true };
  const { createDirectSessionView } = require('../../lib/session-viewer/direct-session');
  const calls = [];
  h.api.moveCodexPage = async (_, direction) => {
    calls.push(direction);
    return { ok: true, session: { ...h.session, page: { ...h.session.page, latest: direction === 'latest' } } };
  };
  const view = createDirectSessionView({ elements: h.elements, viewer: h.viewer, document: h.document, sessionApi: h.api,
    inFileSearch: { onReadActivated() {}, onReadDeactivated() {}, refreshAfterRender() {} } });
  view.show(h.session); assert.equal(parent.scrollTop, 1000);
  await view.move('previous'); assert.equal(parent.scrollTop, 1000);
  await view.move('next'); assert.equal(parent.scrollTop, 0);
  await view.move('latest'); assert.equal(parent.scrollTop, 1000);
  await view.move('first'); assert.equal(parent.scrollTop, 0);
  assert.deepEqual(calls, ['previous', 'next', 'latest', 'first']);
});

test('a new direct-file window opens its inherited file without a file chooser', async () => {
  const h = harness();
  h.api.chooseCodexFile = async () => { throw Error('must not prompt again'); };
  assert.equal(await h.app.initializeWindow({ direct: true }), true);
  assert.equal(h.app.getState().sourceMode, 'codex');
  assert.ok(h.elements.readMount.firstChild);
});
