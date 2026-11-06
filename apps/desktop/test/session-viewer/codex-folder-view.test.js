'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexFolderView, MAX_MOUNTED_ROWS } = require('../../lib/session-viewer/codex-folder-view');
const { makeFakeDocument, flattenText } = require('./read-fake-document');
const { createFavoritesController } = require('../../lib/session-viewer/favorites');

function element(document, tag = 'div') {
  const value = document.createElement(tag);
  value.hidden = false;
  value.disabled = false;
  value.value = '';
  value.dataset = {};
  value.listeners = {};
  value.addEventListener = (type, handler) => { value.listeners[type] = handler; };
  value.click = () => value.listeners.click?.();
  return value;
}

function entry(n, area = 'active', title = `Session ${n}`) {
  const suffix = String(n).padStart(12, '0');
  return {
    entryId: `11111111-1111-4111-8111-${suffix}`,
    sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    title,
    updatedAt: 10000 - n,
    bytes: 20,
    area,
  };
}

function catalog(sourceId, entries, generation = 1) {
  return {
    layout: 'full', sourceId, generation, entries,
    diagnostics: { skipped: 1, errors: 0, duplicates: 2, indexErrors: 0 },
    selectedEntryId: null,
  };
}

function harness() {
  const document = makeFakeDocument();
  const createElement = document.createElement;
  document.createElement = (tag) => {
    const value = createElement(tag);
    value.listeners = {};
    value.addEventListener = (type, handler) => { value.listeners[type] = handler; };
    return value;
  };
  const elements = {
    sessionList: element(document),
    folderFilter: element(document),
    folderFilterInput: element(document, 'input'),
    folderDiagnostics: element(document),
    folderSourceNotice: element(document),
    folderPageStatus: element(document),
    folderPrevPageButton: element(document, 'button'),
    folderNextPageButton: element(document, 'button'),
  };
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  const calls = { loads: [], shows: [], clears: 0, status: [], active: 0 };
  const api = {
    chooseCodexFolder: async () => ({ ok: true, catalog: catalog('source-a', [entry(1)]) }),
    rescanCodexFolder: async () => ({ ok: true, catalog: catalog('source-a', [entry(1)], 2) }),
    cancelCodexFolderScan: async () => ({ ok: true }),
    loadCodexCatalogEntry: async (entryId) => {
      calls.loads.push(entryId);
      return { ok: true, generation: 1, entryId, session: { name: 'Synthetic', sourceBytes: 1, conversation: { messages: [], diagnostics: {} } } };
    },
    reloadCodexCatalogEntry: async () => ({ ok: true, generation: 1, entryId: entry(1).entryId, session: { name: 'Synthetic', sourceBytes: 1, conversation: { messages: [], diagnostics: {} } } }),
  };
  const directView = {
    show(session, options) { calls.shows.push({ session, options }); },
    clear() { calls.clears += 1; },
    markStale() {},
  };
  const view = createCodexFolderView({
    document, elements, sessionApi: api, storage,
    createFavoritesController,
    directView,
    onActivate() { calls.active += 1; },
    onStatus(message, isError, retry) { calls.status.push({ message, isError, retry }); },
    onStateChange() {},
  });
  return { document, elements, storage, values, calls, api, directView, view };
}

function countRows(node) {
  if (!node) return 0;
  return (node.className === 'session-row' ? 1 : 0) +
    (node.children || []).reduce((sum, child) => sum + countRows(child), 0);
}

test('failed selection identifies the attempted session and the preserved reader snapshot', async () => {
  const h = harness();
  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: catalog('source-a', [
    entry(1, 'active', 'Reading now'), entry(2, 'active', 'Too large'),
  ]) });
  await h.view.choose();
  await h.view.openEntry(entry(1).entryId);
  h.api.loadCodexCatalogEntry = async () => ({ ok: false, reason: 'over-cap' });
  assert.equal(await h.view.openEntry(entry(2).entryId), false);
  assert.equal(h.view.getState().selectedEntryId, entry(1).entryId);
  assert.equal(h.calls.shows.length, 1);
  assert.match(h.calls.status.at(-1).message, /Too large/);
  assert.match(h.calls.status.at(-1).message, /读取限制/);
  assert.match(h.calls.status.at(-1).message, /当前仍显示.*Reading now/);
});

test('failed first selection does not claim another conversation is displayed', async () => {
  const h = harness();
  await h.view.choose();
  h.api.loadCodexCatalogEntry = async () => ({ ok: false, reason: 'invalid-file' });
  await h.view.openEntry(entry(1).entryId);
  assert.match(h.calls.status.at(-1).message, /Session 1/);
  assert.doesNotMatch(h.calls.status.at(-1).message, /当前仍显示/);
  assert.equal(h.view.getState().selectedEntryId, null);
});

test('a rejected body request after leaving the source does not change status or throw', async () => {
  const h = harness();
  await h.view.choose();
  let rejectLoad;
  h.api.loadCodexCatalogEntry = () => new Promise((resolve, reject) => { rejectLoad = reject; });
  const pending = h.view.openEntry(entry(1).entryId);
  h.view.clear();
  const statusCount = h.calls.status.length;
  rejectLoad(new Error('Synthetic request failure'));
  assert.equal(await pending, false);
  assert.equal(h.calls.status.length, statusCount);
  assert.equal(h.calls.shows.length, 0);
});

test('renders separate active/archive groups with at most 250 metadata rows', async () => {
  const h = harness();
  const entries = Array.from({ length: 300 }, (_, index) => entry(index + 1));
  entries.push(entry(901, 'archive', 'Archived example'));
  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: catalog('source-a', entries) });

  assert.equal(await h.view.choose(), true);
  assert.equal(MAX_MOUNTED_ROWS, 250);
  assert.equal(countRows(h.elements.sessionList), 250);
  assert.match(flattenText(h.elements.sessionList), /未归档/);
  assert.equal(h.elements.folderNextPageButton.disabled, false);
  h.elements.folderNextPageButton.click();
  assert.equal(countRows(h.elements.sessionList), 51);
  assert.match(flattenText(h.elements.sessionList), /Archive/);
});

test('metadata filtering uses title/session ID without loading a body', async () => {
  const h = harness();
  const special = entry(2, 'archive', 'Special project');
  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: catalog('source-a', [entry(1), special]) });
  await h.view.choose();

  h.view.filter('special');
  assert.equal(countRows(h.elements.sessionList), 1);
  assert.match(flattenText(h.elements.sessionList), /Special project/);
  h.view.filter(special.sessionId.slice(-6));
  assert.equal(countRows(h.elements.sessionList), 1);
  assert.deepEqual(h.calls.loads, []);
});

test('opens and reloads current entries by opaque ID and rejects stale body results', async () => {
  const h = harness();
  await h.view.choose();
  assert.equal(await h.view.openEntry(entry(1).entryId), true);
  assert.deepEqual(h.calls.loads, [entry(1).entryId]);
  assert.equal(h.calls.shows.length, 1);
  assert.match(h.calls.shows[0].options.sourceLabel, /Codex 文件夹/);
  assert.equal(await h.view.reload(), true);

  h.api.loadCodexCatalogEntry = async (entryId) => ({ ok: true, generation: 999, entryId, session: {} });
  assert.equal(await h.view.openEntry(entry(1).entryId), false);
  assert.equal(h.calls.shows.length, 2);
});

test('unavailable body and Reload failures show sanitized status while preserving catalog metadata', async () => {
  const h = harness();
  await h.view.choose();
  const successfulLoad = h.api.loadCodexCatalogEntry;
  h.api.loadCodexCatalogEntry = async () => ({ ok: false, reason: 'invalid-file', detail: '/private/path' });
  assert.equal(await h.view.openEntry(entry(1).entryId), false);
  assert.match(h.calls.status.at(-1).message, /不可用/);
  assert.equal(h.calls.status.at(-1).message.includes('private'), false);
  assert.equal(h.view.getState().entries.length, 1);

  h.api.loadCodexCatalogEntry = successfulLoad;
  await h.view.openEntry(entry(1).entryId);
  h.api.reloadCodexCatalogEntry = async () => ({ ok: false, reason: 'invalid-file', detail: '/private/path' });
  assert.equal(await h.view.reload(), false);
  assert.match(h.calls.status.at(-1).message, /不是最新|可能不是最新/);
  assert.equal(h.calls.status.at(-1).message.includes('private'), false);
});

test('failed Rescan preserves the catalog; successful Rescan tracks logical session or clears a removed selection', async () => {
  const h = harness();
  await h.view.choose();
  await h.view.openEntry(entry(1).entryId);
  h.api.rescanCodexFolder = async () => ({ ok: false, reason: 'invalid-source' });
  assert.equal(await h.view.rescan(), false);
  assert.equal(h.view.getState().selectedSessionId, entry(1).sessionId);

  const moved = { ...entry(1, 'archive'), entryId: '22222222-2222-4222-8222-000000000001' };
  h.api.rescanCodexFolder = async () => ({ ok: true, catalog: { ...catalog('source-a', [moved], 2), selectedEntryId: moved.entryId } });
  assert.equal(await h.view.rescan(), true);
  assert.equal(h.view.getState().selectedEntryId, moved.entryId);

  h.api.rescanCodexFolder = async () => ({ ok: true, catalog: catalog('source-a', [], 3) });
  assert.equal(await h.view.rescan(), true);
  assert.equal(h.view.getState().selectedSessionId, null);
  assert.equal(h.calls.clears > 0, true);
});

test('favorites are source-scoped and follow a logical session through archive movement', async () => {
  const h = harness();
  await h.view.choose();
  h.view.toggleFavorite(entry(1).sessionId);
  assert.equal(h.view.isFavorite(entry(1).sessionId), true);

  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: catalog('source-b', [entry(1)]) });
  await h.view.choose();
  assert.equal(h.view.isFavorite(entry(1).sessionId), false);

  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: catalog('source-a', [{ ...entry(1), area: 'archive' }], 3) });
  await h.view.choose();
  assert.equal(h.view.isFavorite(entry(1).sessionId), true);
});

test('favorite keyboard activation does not bubble into the row body loader', async () => {
  const h = harness();
  await h.view.choose();
  const row = h.elements.sessionList.children[0].children[1];
  const star = row.children[0];
  const event = {
    key: 'Enter', prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };

  star.listeners.keydown?.(event);
  if (!event.stopped) row.listeners.keydown?.(event);

  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(h.view.isFavorite(entry(1).sessionId), true);
  assert.deepEqual(h.calls.loads, []);
});

test('cancel requests are visible and a cancelled scan preserves the current catalog', async () => {
  const h = harness();
  await h.view.choose();
  let finish;
  h.api.rescanCodexFolder = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.view.rescan();
  assert.equal(h.view.getState().scanning, true);
  assert.equal(await h.view.cancel(), true);
  finish({ ok: false, reason: 'cancelled' });
  assert.equal(await pending, false);
  assert.equal(h.view.getState().entries.length, 1);
  assert.match(h.calls.status.at(-1).message, /取消/);
});


test('active-only selection explains missing names without broadening the source or reading bodies', async () => {
  const h = harness();
  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: {
    ...catalog('source-a', [entry(1)]), layout: 'active-only', titleIndexState: 'not-selected',
  } });
  await h.view.choose();
  assert.match(h.elements.folderSourceNotice.textContent, /仅显示未归档对话/);
  assert.match(h.elements.folderDiagnostics.textContent, /上级 Codex 文件夹/);
  assert.match(h.elements.folderDiagnostics.textContent, /session_index.jsonl/);
  assert.equal(h.calls.loads.length, 0);
  h.view.clear();
  assert.equal(h.elements.folderSourceNotice.hidden, true);
});

test('full-root notices distinguish missing, unavailable and loaded title indexes and update on Rescan', async () => {
  const h = harness();
  const next = { ...catalog('source-a', [entry(1)]), titleIndexState: 'missing' };
  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: next });
  h.api.rescanCodexFolder = async () => ({ ok: true, catalog: next });
  await h.view.choose();
  assert.match(h.elements.folderSourceNotice.textContent, /没有名称索引/);
  next.titleIndexState = 'unavailable';
  await h.view.rescan();
  assert.match(h.elements.folderSourceNotice.textContent, /名称索引暂不可用/);
  next.titleIndexState = 'loaded';
  next.diagnostics = { skipped: 5, errors: 0, duplicates: 0, indexErrors: 1, named: 1,
    skippedReasons: { compressed: 1, unsupportedName: 1, layout: 1, unsafe: 1, other: 1 } };
  next.entries[0].title = 'Latest renamed title';
  await h.view.rescan();
  assert.match(h.elements.folderSourceNotice.textContent, /1 个未归档对话中，1 个已读取名称/);
  assert.match(h.elements.folderSourceNotice.textContent, /已排除 5 项/);
  assert.match(h.elements.folderDiagnostics.textContent, /1 项压缩文件名不支持/);
  assert.match(h.elements.folderDiagnostics.textContent, /1 项文件名不支持/);
  assert.match(h.elements.folderDiagnostics.textContent, /1 项不符合日期目录布局/);
  assert.match(h.elements.folderDiagnostics.textContent, /1 项无法安全读取/);
  assert.match(h.elements.folderDiagnostics.textContent, /1 项其他/);
  assert.match(flattenText(h.elements.sessionList), /Latest renamed title/);
  assert.equal(h.calls.loads.length, 0);
});

test('folder explains metadata-based review exclusion and standalone recovery', async () => {
  const h = harness(), c = catalog('source-a', [entry(1)]);
  c.diagnostics.hiddenReviews = 12;
  c.diagnostics.hiddenBackground = 7;
  c.diagnostics.hiddenAutomation = 23;
  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: c });
  await h.view.choose();
  assert.match(h.elements.folderSourceNotice.textContent, /已隐藏 12 个后台审核/);
  assert.match(h.elements.folderDiagnostics.textContent, /根据来源信息.*单文件入口/);
  assert.match(h.elements.folderSourceNotice.textContent, /隐藏 7 个子代理或后台会话/);
  assert.match(h.elements.folderDiagnostics.textContent, /隐藏 7 个子代理或后台会话/);
  assert.match(h.elements.folderSourceNotice.textContent, /已隐藏 23 个非交互记录/);
  assert.match(h.elements.folderDiagnostics.textContent, /23 个非交互记录.*exec.*mcp/);
});


test('favorite-only browsing filters the full catalog before paging without body reads', async () => {
  const h = harness();
  const entries = Array.from({ length: 301 }, (_, i) => entry(i + 1));
  h.api.chooseCodexFolder = async () => ({ ok: true, catalog: catalog('source-a', entries) });
  await h.view.choose();
  h.view.toggleFavorite(entry(301).sessionId);
  h.view.setFavoritesOnly(true);
  assert.equal(countRows(h.elements.sessionList), 1);
  assert.match(flattenText(h.elements.sessionList), /Session 301/);
  assert.equal(h.elements.folderNextPageButton.disabled, true);
  h.view.filter('missing');
  assert.equal(countRows(h.elements.sessionList), 0);
  h.view.filter('');
  h.view.toggleFavorite(entry(301).sessionId);
  assert.equal(countRows(h.elements.sessionList), 0);
  h.view.setFavoritesOnly(false);
  assert.equal(countRows(h.elements.sessionList), 250);
  assert.deepEqual(h.calls.loads, []);
});


test('failed selection retries the attempted entry and empty filters explain recovery', async () => {
  const h = harness(); await h.view.choose();
  h.api.loadCodexCatalogEntry = async () => ({ ok: false, reason: 'unavailable' });
  await h.view.openEntry(entry(1).entryId);
  const retry = h.calls.status.at(-1).retry;
  assert.equal(typeof retry, 'function');
  let opened;
  h.api.loadCodexCatalogEntry = async id => { opened = id; return { ok: true, generation: 1, entryId: id, session: {} }; };
  assert.equal(await retry(), true); assert.equal(opened, entry(1).entryId);
  h.view.filter('missing synthetic title');
  assert.match(flattenText(h.elements.sessionList), /没有找到匹配的会话/);
  assert.equal(h.elements.folderNextPageButton.disabled, true);
  h.view.filter(''); h.view.setFavoritesOnly(true);
  assert.match(flattenText(h.elements.sessionList), /还没有收藏/);
});
