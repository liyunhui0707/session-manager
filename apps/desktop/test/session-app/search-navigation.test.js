'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionApp } = require('../../lib/session-app');
const SearchIndex = require('../../lib/session-viewer/search-index');
const SearchDom = require('../../lib/session-viewer/search-dom');
const Read = require('../../lib/session-viewer/read-renderer');
const { createInFileSearchToolbar } = require('../../lib/session-viewer/in-file-search-toolbar');
const { makeFakeDocument, flattenText, findAllByTag } = require('../session-viewer/read-fake-document');

function session(id, body, large = false) {
  return { id, relativePath: `codex/${id}.md`, title: id, body, large, agent: 'codex', sessionsImport: true };
}

function harness(initialSessions) {
  const doc = makeFakeDocument();
  const createElement = doc.createElement;
  const scrolls = [];
  let rendered = 0;
  doc.createElement = (tag) => {
    const el = createElement(tag);
    el.listeners = {};
    el.dataset = {};
    el.value = '';
    el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
    el.click = () => el.listeners.click();
    el.scrollIntoView = () => scrolls.push(el);
    return el;
  };
  const elements = Object.fromEntries([
    'chooseLibraryButton', 'refreshButton', 'status', 'libraryWarning', 'refreshResult', 'libraryPath',
    'sessionList', 'globalSearchInput', 'globalSearchResults', 'globalSearchBanner',
    'readTitle', 'readMount', 'inFileSearchToolbar', 'inFileSearchInput',
    'inFileSearchPrev', 'inFileSearchNext', 'inFileSearchCounter', 'largeSessionNotice',
    'loadLargeSessionButton', 'emptyState',
  ].map((key) => [key, doc.createElement('div')]));
  const viewer = {
    ...SearchIndex, ...SearchDom, createInFileSearchToolbar,
    extractReadTextRuns: (body) => require('../../lib/session-viewer/read-search-text').extractReadTextRuns(body),
    renderMarkdown(body, opts) { rendered += 1; return Read.renderMarkdown(body, opts); },
    isLargeSession: (note) => note.large,
    createFavoritesController: () => ({ isFavorite: () => false, toggle() {} }),
    groupAndSort: (items) => items,
    createGroupedListRenderer: () => ({ render() {} }),
  };
  let next = { ok: true, libraryPath: '/synthetic/library', sessions: initialSessions };
  const app = createSessionApp({
    document: doc, elements, sessionViewer: viewer,
    sessionApi: {
      async loadSessions() { return next; },
      async chooseLibrary() { return next; },
    },
  });
  return { app, elements, viewer, scrolls, rendered: () => rendered,
    replace(sessions) { next = { ok: true, libraryPath: '/synthetic/replacement', sessions }; } };
}

test('global result opens with the query highlighted and scrolls to its first visible match', async () => {
  const h = harness([session('a', '## User\n\nNeedle and **needle**')]);
  await h.app.initialize();
  const results = await h.app.searchAll('  nEeDlE  ');
  assert.equal(results[0].matchCount, 2);
  h.elements.globalSearchResults.children[0].click();
  assert.equal(h.elements.inFileSearchInput.value, 'nEeDlE');
  assert.equal(h.elements.inFileSearchCounter.textContent, '1/2');
  const marks = findAllByTag(h.elements.readMount, 'mark');
  assert.deepEqual(h.scrolls, [marks[0]]);
  assert.equal(flattenText(marks[0]), 'Needle');
  h.elements.inFileSearchNext.click();
  assert.equal(h.elements.inFileSearchCounter.textContent, '2/2');
  h.elements.inFileSearchInput.value = 'User';
  h.elements.inFileSearchInput.listeners.input();
  assert.equal(h.scrolls.length, 2, 'typing does not force another scroll');
});

test('global search excludes hidden tools and cannot match across formatting boundaries', async () => {
  const h = harness([session('a', '## User\n\nleft**right**\n\n## Assistant\n\n### Tool result\nonlyhiddenneedle')]);
  await h.app.initialize();
  assert.deepEqual(await h.app.searchAll('onlyhiddenneedle'), []);
  assert.deepEqual(await h.app.searchAll('leftright'), []);
  assert.deepEqual(await h.app.searchAll('left**right'), []);
  assert.equal((await h.app.searchAll('right'))[0].matchCount, 1);
});

test('large search result retains the query until explicit load, without browser rendering during indexing', async () => {
  const h = harness([session('large', '## User\n\nneedle '.repeat(10000), true)]);
  await h.app.initialize();
  const results = await h.app.searchAll('needle');
  assert.equal(h.rendered(), 0);
  h.elements.globalSearchResults.children[0].click();
  assert.equal(h.rendered(), 0);
  assert.equal(h.elements.largeSessionNotice.hidden, false);
  assert.equal(h.elements.inFileSearchToolbar.hidden, true);
  assert.equal(h.scrolls.length, 0);
  h.elements.loadLargeSessionButton.click();
  assert.equal(h.rendered(), 1);
  assert.equal(h.elements.inFileSearchInput.value, 'needle');
  assert.equal(h.elements.inFileSearchCounter.textContent, `1/${results[0].matchCount}`);
  assert.equal(h.scrolls.length, 1);
});

test('normal selection discards a pending search query from a deferred session', async () => {
  const h = harness([session('a', '## User\n\nneedle', true), session('b', '## User\n\nneedle', true)]);
  await h.app.initialize();
  await h.app.searchAll('needle');
  h.elements.globalSearchResults.children[0].click();
  h.app.selectSession('b');
  h.app.loadSelectedLargeSession();
  assert.equal(h.elements.inFileSearchInput.value, '');
  assert.equal(h.elements.inFileSearchCounter.textContent, '0/0');
  assert.equal(h.scrolls.length, 0);
});

test('replacement library discards deferred queries and old result callbacks, even for reused IDs', async () => {
  const h = harness([session('same', '## User\n\noldneedle', true)]);
  await h.app.initialize();
  await h.app.searchAll('oldneedle');
  const oldRow = h.elements.globalSearchResults.children[0];
  oldRow.click();
  h.replace([session('same', '## User\n\nnewneedle', true)]);
  await h.app.chooseLibrary();
  oldRow.click();
  assert.equal(h.app.getState().selectedId, null);
  h.app.selectSession('same');
  h.app.loadSelectedLargeSession();
  assert.equal(h.elements.inFileSearchInput.value, '');
  assert.equal(h.scrolls.length, 0);
});

test('superseded result callbacks cannot navigate, including after a query is cleared', async () => {
  const h = harness([session('a', '## User\n\nfirst second')]);
  await h.app.initialize();
  await h.app.searchAll('first');
  const firstRow = h.elements.globalSearchResults.children[0];
  await h.app.searchAll('second');
  firstRow.click();
  assert.equal(h.app.getState().selectedId, null);
  const secondRow = h.elements.globalSearchResults.children[0];
  await h.app.searchAll('');
  secondRow.click();
  assert.equal(h.app.getState().selectedId, null);
});

test('only the latest query renders after an asynchronous index build', async () => {
  const h = harness([session('a', '## User\n\nfirst second')]);
  let release;
  const build = h.viewer.loadGlobalIndex;
  h.viewer.loadGlobalIndex = async (...args) => {
    await new Promise((resolve) => { release = resolve; });
    return build(...args);
  };
  await h.app.initialize();
  const first = h.app.searchAll('first');
  const second = h.app.searchAll('second');
  release();
  assert.deepEqual(await first, []);
  await second;
  h.elements.globalSearchResults.children[0].click();
  assert.equal(h.elements.inFileSearchInput.value, 'second');
});

test('an old index finishing after library replacement cannot replace new results', async () => {
  const h = harness([session('old', '## User\n\noldneedle')]);
  let release;
  const build = h.viewer.loadGlobalIndex;
  h.viewer.loadGlobalIndex = async (...args) => {
    if (args[1][0].id === 'old') await new Promise((resolve) => { release = resolve; });
    return build(...args);
  };
  await h.app.initialize();
  const oldSearch = h.app.searchAll('oldneedle');
  h.replace([session('new', '## User\n\nnewneedle')]);
  await h.app.chooseLibrary();
  await h.app.searchAll('newneedle');
  release();
  assert.deepEqual(await oldSearch, []);
  h.elements.globalSearchResults.children[0].click();
  assert.equal(h.app.getState().selectedId, 'new');
  assert.equal(h.elements.inFileSearchInput.value, 'newneedle');
});

test('a later clicked result replaces the query waiting for large-session confirmation', async () => {
  const h = harness([session('large', '## User\n\nfirst second', true)]);
  await h.app.initialize();
  await h.app.searchAll('first');
  h.elements.globalSearchResults.children[0].click();
  await h.app.searchAll('second');
  h.elements.globalSearchResults.children[0].click();
  h.app.loadSelectedLargeSession();
  assert.equal(h.elements.inFileSearchInput.value, 'second');
  assert.equal(flattenText(h.scrolls[0]), 'second');
});
