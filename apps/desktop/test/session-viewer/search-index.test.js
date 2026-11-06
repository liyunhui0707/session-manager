/* Stage S4 — unit tests for search-index.js
   Run: node --test test/session-viewer/search-index.test.js  */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SearchIndex = require('../../lib/session-viewer/search-index');
const { makeFakeDocument } = require('./read-fake-document');

// ---------- countSubstringOccurrences ----------

test('T-S4-16 countSubstringOccurrences returns 0 for empty/missing input', () => {
  assert.equal(SearchIndex.countSubstringOccurrences('', 'x'), 0);
  assert.equal(SearchIndex.countSubstringOccurrences('hello', ''), 0);
  assert.equal(SearchIndex.countSubstringOccurrences(null, 'x'), 0);
});

test('T-S4-17 countSubstringOccurrences returns 0 for no match', () => {
  assert.equal(SearchIndex.countSubstringOccurrences('hello', 'xyz'), 0);
});

test('T-S4-18 countSubstringOccurrences case-insensitive single', () => {
  assert.equal(SearchIndex.countSubstringOccurrences('HeLLo World', 'hello'), 1);
});

test('T-S4-19 countSubstringOccurrences non-overlapping multi', () => {
  // "aaaa" with needle "aa" → 2 (i=0, then i=2).
  assert.equal(SearchIndex.countSubstringOccurrences('aaaa', 'aa'), 2);
});

// ---------- buildGlobalIndex ----------

test('T-S4-20 buildGlobalIndex runs with concurrency cap (no exception)', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `n${i}`,
    title: `Note ${i}`,
    sourceMtime: i,
  }));
  const fetchFn = async (it) => ({ content: `body of ${it.id}` });
  const out = await SearchIndex.buildGlobalIndex(
    items,
    fetchFn,
    (s) => s,
    () => true,
    { concurrency: 3 },
  );
  assert.equal(out.length, 10);
  // shape
  for (const entry of out) {
    assert.ok('id' in entry);
    assert.ok('title' in entry);
    assert.ok('mtime' in entry);
    assert.ok('textContent' in entry);
  }
});

test('T-S4-21 buildGlobalIndex swallows fetch failure', async () => {
  const items = [
    { id: 'a', title: 'A', sourceMtime: 0 },
    { id: 'b', title: 'B', sourceMtime: 1 },
  ];
  const fetchFn = async (it) => {
    if (it.id === 'a') throw new Error('boom');
    return { content: `body ${it.id}` };
  };
  const out = await SearchIndex.buildGlobalIndex(
    items, fetchFn, (s) => s, () => true,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'b');
});

test('T-S4-22 buildGlobalIndex respects isSupported filter', async () => {
  const items = [
    { id: 'a', title: 'A', sourceMtime: 0, supported: true },
    { id: 'b', title: 'B', sourceMtime: 0, supported: false },
  ];
  const out = await SearchIndex.buildGlobalIndex(
    items,
    async (it) => ({ content: it.id }),
    (s) => s,
    (it) => it.supported === true,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
});

test('T-S4-23 buildGlobalIndex extractText receives content', async () => {
  const items = [{ id: 'x', title: 'X', sourceMtime: 0 }];
  const captured = [];
  await SearchIndex.buildGlobalIndex(
    items,
    async () => ({ content: '<raw body>' }),
    (s) => { captured.push(s); return s.toUpperCase(); },
    () => true,
  );
  assert.equal(captured[0], '<raw body>');
});

// ---------- searchIndex ----------

test('T-S4-24 searchIndex returns [] under MIN_GLOBAL_QUERY_LEN', () => {
  const idx = [{ id: 'a', title: 'A', mtime: 0, textContent: 'hello' }];
  assert.deepEqual(SearchIndex.searchIndex(idx, ''), []);
  assert.deepEqual(SearchIndex.searchIndex(idx, 'h'), []);
});

test('T-S4-25 searchIndex sorts by matchCount desc then mtime desc', () => {
  const idx = [
    { id: 'a', title: 'A', mtime: 1, textContent: 'foo foo' },          // 2
    { id: 'b', title: 'B', mtime: 9, textContent: 'foo bar baz' },       // 1
    { id: 'c', title: 'C', mtime: 3, textContent: 'foo foo foo foo' },   // 4
    { id: 'd', title: 'D', mtime: 99, textContent: 'foo' },              // 1
  ];
  const results = SearchIndex.searchIndex(idx, 'foo');
  assert.deepEqual(results.map((r) => r.id), ['c', 'a', 'd', 'b']);
});

test('T-S4-26 searchIndex returns [] for null index', () => {
  assert.deepEqual(SearchIndex.searchIndex(null, 'foo'), []);
});

// ---------- loadGlobalIndex lifecycle ----------

test('T-S4-27 loadGlobalIndex lifecycle (idle → loading → ready) + progress', async () => {
  const state = { globalIndex: null, globalIndexStatus: 'idle' };
  const items = Array.from({ length: 3 }, (_, i) => ({
    id: `n${i}`, title: `T${i}`, sourceMtime: i,
  }));
  const progresses = [];
  await SearchIndex.loadGlobalIndex(
    state,
    items,
    async (it) => ({ content: `body ${it.id}` }),
    (s) => s,
    () => true,
    (p) => progresses.push({ ...p }),
  );
  assert.equal(state.globalIndexStatus, 'ready');
  assert.equal(Array.isArray(state.globalIndex), true);
  assert.equal(state.globalIndex.length, 3);
  // First progress is total=3 done=0; last is total=3 done=3.
  assert.equal(progresses[0].total, 3);
  assert.equal(progresses[0].done, 0);
  assert.equal(progresses[progresses.length - 1].done, 3);
});

test('T-S4-27b loadGlobalIndex no-ops when already ready', async () => {
  const state = {
    globalIndex: [{ id: 'old', title: '', mtime: 0, textContent: '' }],
    globalIndexStatus: 'ready',
  };
  await SearchIndex.loadGlobalIndex(
    state, [{ id: 'new', title: '', sourceMtime: 0 }],
    async () => ({ content: 'x' }), (s) => s, () => true,
  );
  assert.equal(state.globalIndex.length, 1);
  assert.equal(state.globalIndex[0].id, 'old');
});

// ---------- nextMatchIndex / prevMatchIndex ----------

test('T-S4-28 nextMatchIndex wraps from last to 0', () => {
  assert.equal(SearchIndex.nextMatchIndex(2, 3), 0);
  assert.equal(SearchIndex.nextMatchIndex(0, 3), 1);
});

test('T-S4-28b prevMatchIndex wraps from 0 to last', () => {
  assert.equal(SearchIndex.prevMatchIndex(0, 3), 2);
  assert.equal(SearchIndex.prevMatchIndex(2, 3), 1);
});

test('T-S4-28c both return 0 when total=0', () => {
  assert.equal(SearchIndex.nextMatchIndex(0, 0), 0);
  assert.equal(SearchIndex.prevMatchIndex(0, 0), 0);
});

// ---------- renderGlobalResults ----------

test('T-S4-29 renderGlobalResults builds rows with title + match-count badge', () => {
  const doc = makeFakeDocument();
  const container = doc.createElement('div');
  const calls = [];
  const results = [
    { id: 'a', title: 'Alpha', mtime: 0, matchCount: 5 },
    { id: 'b', title: 'Beta',  mtime: 0, matchCount: 1 },
  ];
  SearchIndex.renderGlobalResults(container, results, doc, (id) => calls.push(id));
  assert.equal(container.children.length, 2);
  assert.equal(container.children[0].attrs.class, 'sidebar-search-result-row');
  // Title is the first child <span>.
  assert.equal(container.children[0].children[0].children[0].textContent, 'Alpha');
  // Badge (last child) shows the count.
  const r0 = container.children[0];
  const r0Last = r0.children[r0.children.length - 1];
  assert.equal(r0Last.attrs.class, 'sidebar-search-result-badge');
  assert.equal(r0Last.children[0].textContent, '5');
  // Shim path: __onClick stashed for tests.
  container.children[1].__onClick();
  assert.deepEqual(calls, ['b']);
});

test('T-S4-29b renderGlobalResults clears prior rows on rerender', () => {
  const doc = makeFakeDocument();
  const container = doc.createElement('div');
  SearchIndex.renderGlobalResults(
    container,
    [{ id: 'a', title: 'A', mtime: 0, matchCount: 1 }],
    doc, () => {},
  );
  assert.equal(container.children.length, 1);
  SearchIndex.renderGlobalResults(container, [], doc, () => {});
  assert.equal(container.children.length, 0);
});

test('T-S4-29c renderGlobalResults never writes innerHTML', () => {
  const doc = makeFakeDocument();
  const container = doc.createElement('div');
  SearchIndex.renderGlobalResults(
    container,
    [{ id: 'a', title: 'A', mtime: 0, matchCount: 1 }],
    doc, () => {},
  );
  assert.equal(doc.unsafeApiWrites, 0);
});

test('T-S4-29d renderGlobalResults respects opts.isFavorite indicator', () => {
  const doc = makeFakeDocument();
  const container = doc.createElement('div');
  SearchIndex.renderGlobalResults(
    container,
    [{ id: 'fav', title: 'Fav', mtime: 0, matchCount: 1 }],
    doc, () => {},
    { isFavorite: (id) => id === 'fav' },
  );
  // row should now have 3 children (title, indicator, badge).
  const row = container.children[0];
  assert.equal(row.children.length, 3);
  assert.equal(row.children[1].attrs.class, 'favorite-indicator');
});
