'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSessionApp } = require('../../lib/session-app');
const { createInFileSearchToolbar } = require('../../lib/session-viewer/in-file-search-toolbar');

function makeElement() {
  const listeners = {};
  const element = {
    listeners,
    children: [],
    hidden: false,
    textContent: '',
    value: '',
    disabled: false,
    setAttribute(name, value) { this[name] = String(value); },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
    },
    get firstChild() {
      return this.children[0] || null;
    },
  };
  Object.defineProperty(element, 'dataset', {
    value: {},
    writable: false,
    enumerable: true,
  });
  return element;
}

function makeElements() {
  return {
    chooseLibraryButton: makeElement(),
    refreshButton: makeElement(),
    refreshMount: makeElement(),
    libraryPath: makeElement(),
    status: makeElement(),
    libraryWarning: makeElement(),
    refreshResult: makeElement(),
    sessionList: makeElement(),
    globalSearchInput: makeElement(),
    globalSearchResults: makeElement(),
    globalSearchBanner: makeElement(),
    readTitle: makeElement(),
    readMount: makeElement(),
    inFileSearchToolbar: makeElement(),
    inFileSearchInput: makeElement(),
    inFileSearchPrev: makeElement(),
    inFileSearchNext: makeElement(),
    inFileSearchCounter: makeElement(),
    largeSessionNotice: makeElement(),
    loadLargeSessionButton: makeElement(),
    emptyState: makeElement(),
  };
}

function makeStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function makeViewer() {
  const calls = {
    trees: [],
    renderedBodies: [],
    globalResults: [],
  };
  const favorites = new Set();
  return {
    calls,
    MIN_GLOBAL_QUERY_LEN: 2,
    LARGE_SESSION_CHARS: 10,
    createFavoritesController() {
      return {
        isFavorite(value) { return favorites.has(value); },
        toggle(value) {
          if (favorites.has(value)) favorites.delete(value);
          else favorites.add(value);
          return favorites.has(value);
        },
      };
    },
    groupAndSort(items) {
      return { codex: [{ label: 'Today', layerId: 'today', items }], claude: [], other: [], counts: { codex: { sessions: items.length } } };
    },
    createGroupedListRenderer(options) {
      return {
        render(tree, selectedId) {
          calls.trees.push({ tree, selectedId, options });
        },
      };
    },
    createInFileSearchToolbar,
    renderMarkdown(body) {
      calls.renderedBodies.push(body);
      return { body };
    },
    isLargeSession(note) {
      return note.body.length >= 10;
    },
    async loadGlobalIndex(state, items) {
      state.globalIndex = items.map((item) => ({
        id: item.id,
        title: item.title,
        mtime: item.sourceMtime,
        textContent: item.body,
      }));
      state.globalIndexStatus = 'ready';
    },
    searchIndex(index, query) {
      return index
        .filter((entry) => entry.textContent.includes(query))
        .map((entry) => ({ ...entry, matchCount: 1 }));
    },
    renderGlobalResults(_container, results) {
      calls.globalResults.push(results);
    },
  };
}

test('choose, group, favorite, search, and render a standalone session library', async () => {
  const elements = makeElements();
  const viewer = makeViewer();
  const sessions = [
    {
      id: 'codex/a.md',
      relativePath: 'codex/a.md',
      title: 'A',
      body: 'short',
      agent: 'codex',
      sessionsImport: true,
      sourceMtime: 1,
    },
  ];
  const sessionApi = {
    async getSelectedLibrary() {
      return { ok: true, libraryPath: null };
    },
    async loadSessions() {
      return { ok: false, reason: 'no-library' };
    },
    async chooseLibrary() {
      return { ok: true, libraryPath: '/chosen/library', sessions };
    },
    async refreshSessions() {
      return { ok: true };
    },
  };

  const app = createSessionApp({
    elements,
    document: { createTextNode: (text) => ({ textContent: text }) },
    sessionApi,
    storage: makeStorage(),
    sessionViewer: viewer,
  });

  assert.equal(elements.refreshButton.disabled, true);
  await app.initialize();
  assert.equal(elements.emptyState.hidden, false);

  await app.chooseLibrary();
  assert.equal(elements.libraryPath.textContent, '/chosen/library');
  assert.equal(viewer.calls.trees.length > 0, true);

  app.selectSession('codex/a.md');
  assert.equal(elements.readTitle.textContent, 'A');
  assert.deepEqual(viewer.calls.renderedBodies, ['short']);

  app.toggleFavorite('codex/a.md');
  assert.equal(viewer.calls.trees.at(-1).tree.codex[0].items.length, 1);

  const results = await app.searchAll('short');
  assert.equal(results.length, 1);
  assert.equal(viewer.calls.globalResults.at(-1)[0].id, 'codex/a.md');
});

test('partial-load warning persists while browsing and clears after a clean reload', async () => {
  const elements = makeElements();
  const session = { id: 'codex/good.md', relativePath: 'codex/good.md', title: 'Good', body: 'short', agent: 'codex' };
  let skippedFiles = 2;
  const result = () => ({ ok: true, libraryPath: '/synthetic/library', sessions: [session], skippedFiles });
  const app = createSessionApp({
    elements, document: {}, sessionViewer: makeViewer(),
    sessionApi: {
      async loadSessions() { return result(); },
      async chooseLibrary() { return { ok: false, reason: 'cancelled' }; },
      async refreshSessions() { return { ok: true }; },
    },
  });
  await app.initialize();
  assert.equal(elements.libraryWarning.hidden, false);
  assert.match(elements.libraryWarning.textContent, /2 个会话文件未能读取/);
  app.selectSession(session.id);
  assert.equal(elements.readTitle.textContent, 'Good');
  await app.chooseLibrary();
  assert.equal(elements.libraryWarning.hidden, false);
  skippedFiles = 0;
  await app.refreshSessions();
  assert.equal(elements.libraryWarning.hidden, true);
  assert.equal(elements.libraryWarning.textContent, '');
});

test('all-skipped library remains selected and warns; invalid subsequent load clears warning', async () => {
  const elements = makeElements();
  let result = { ok: true, libraryPath: '/synthetic/library', sessions: [], skippedFiles: 1 };
  const app = createSessionApp({
    elements, document: {}, sessionViewer: makeViewer(),
    sessionApi: { async loadSessions() { return result; } },
  });
  assert.equal(await app.initialize(), true);
  assert.equal(elements.emptyState.hidden, false);
  assert.equal(elements.refreshButton.disabled, false);
  assert.match(elements.libraryWarning.textContent, /1 个会话文件未能读取/);
  result = { ok: false, reason: 'invalid-library' };
  assert.equal(await app.initialize(), false);
  assert.equal(elements.libraryWarning.hidden, true);
  assert.equal(elements.libraryWarning.textContent, '');
});

test('cancelling a replacement library keeps the current library and sessions', async () => {
  const elements = makeElements();
  const viewer = makeViewer();
  const sessions = [{
    id: 'codex/a.md',
    relativePath: 'codex/a.md',
    title: 'A',
    body: 'body',
    agent: 'codex',
    sessionsImport: true,
  }];
  const app = createSessionApp({
    elements,
    document: { createTextNode: (text) => ({ textContent: text }) },
    sessionApi: {
      async loadSessions() { return { ok: true, libraryPath: '/current', sessions }; },
      async chooseLibrary() { return { ok: false, reason: 'cancelled' }; },
      async refreshSessions() { throw new Error('not used'); },
    },
    storage: makeStorage(),
    sessionViewer: viewer,
  });

  await app.initialize();
  assert.equal(await app.chooseLibrary(), false);
  assert.equal(app.getState().libraryPath, '/current');
  assert.equal(app.getState().sessions.length, 1);
  assert.equal(elements.libraryPath.textContent, '/current');
});

test('large transcripts are deferred until explicitly requested', async () => {
  const elements = makeElements();
  const viewer = makeViewer();
  const session = {
    id: 'claude-code/large.md',
    relativePath: 'claude-code/large.md',
    title: 'Large',
    body: '0123456789 large transcript',
    agent: 'claude',
    sessionsImport: true,
  };
  const app = createSessionApp({
    elements,
    document: { createTextNode: (text) => ({ textContent: text }) },
    sessionApi: {
      async loadSessions() {
        return { ok: true, libraryPath: '/library', sessions: [session] };
      },
      async chooseLibrary() {
        throw new Error('not used');
      },
      async refreshSessions() {
        throw new Error('not used');
      },
    },
    storage: makeStorage(),
    sessionViewer: viewer,
  });

  await app.initialize();
  app.selectSession(session.id);
  assert.equal(elements.largeSessionNotice.hidden, false);
  assert.deepEqual(viewer.calls.renderedBodies, []);

  app.loadSelectedLargeSession();
  assert.equal(elements.largeSessionNotice.hidden, true);
  assert.deepEqual(viewer.calls.renderedBodies, [session.body]);
});

test('refresh is disabled while import is running and enabled afterward', async () => {
  const elements = makeElements();
  const viewer = makeViewer();
  let releaseRefresh;
  const app = createSessionApp({
    elements,
    document: { createTextNode: (text) => ({ textContent: text }) },
    sessionApi: {
      async loadSessions() {
        return { ok: true, libraryPath: '/library', sessions: [] };
      },
      async chooseLibrary() { throw new Error('not used'); },
      refreshSessions() {
        return new Promise((resolve) => { releaseRefresh = resolve; });
      },
    },
    storage: makeStorage(),
    sessionViewer: viewer,
  });

  await app.initialize();
  const refresh = app.refreshSessions();
  assert.equal(elements.refreshButton.disabled, true);
  releaseRefresh({ ok: true });
  assert.equal(await refresh, true);
  assert.equal(elements.refreshButton.disabled, false);
});

test('only the latest concurrent cross-session query renders results', async () => {
  const elements = makeElements();
  const viewer = makeViewer();
  let releaseIndex;
  viewer.loadGlobalIndex = async (state, items) => {
    await new Promise((resolve) => { releaseIndex = resolve; });
    state.globalIndex = items.map((item) => ({
      id: item.id,
      title: item.title,
      textContent: item.body,
    }));
    state.globalIndexStatus = 'ready';
  };
  const sessions = [
    {
      id: 'codex/a.md',
      relativePath: 'codex/a.md',
      title: 'A',
      body: 'first second',
      agent: 'codex',
      sessionsImport: true,
    },
  ];
  const app = createSessionApp({
    elements,
    document: { createTextNode: (text) => ({ textContent: text }) },
    sessionApi: {
      async loadSessions() { return { ok: true, libraryPath: '/library', sessions }; },
      async chooseLibrary() { throw new Error('not used'); },
      async refreshSessions() { throw new Error('not used'); },
    },
    storage: makeStorage(),
    sessionViewer: viewer,
  });

  await app.initialize();
  const first = app.searchAll('first');
  await Promise.resolve();
  const second = app.searchAll('second');
  releaseIndex();
  await Promise.all([first, second]);

  assert.equal(viewer.calls.globalResults.length, 1);
  assert.equal(viewer.calls.globalResults[0][0].id, 'codex/a.md');
});

test('replacing a library clears old results, query, reader search, and deferred-load state', async () => {
  const elements = makeElements();
  const viewer = makeViewer();
  const session = { id: 'codex/a.md', relativePath: 'codex/a.md', title: 'Old', body: 'old private content', agent: 'codex' };
  const app = createSessionApp({
    elements,
    document: { createTextNode: (text) => ({ textContent: text }) },
    sessionApi: {
      async loadSessions() { return { ok: true, libraryPath: '/old', sessions: [session] }; },
      async chooseLibrary() { return { ok: true, libraryPath: '/new', sessions: [] }; },
    },
    sessionViewer: viewer,
  });
  await app.initialize();
  app.selectSession(session.id);
  app.loadSelectedLargeSession();
  app.selectSession(session.id);
  elements.globalSearchInput.value = 'private';
  elements.globalSearchResults.appendChild({ textContent: 'Old private result' });
  elements.globalSearchBanner.hidden = false;
  elements.inFileSearchInput.value = 'old query';

  await app.chooseLibrary();

  assert.equal(elements.globalSearchResults.children.length, 0);
  assert.equal(elements.globalSearchInput.value, '');
  assert.equal(elements.globalSearchBanner.hidden, true);
  assert.equal(elements.largeSessionNotice.hidden, true);
  assert.equal(elements.inFileSearchToolbar.hidden, true);
  assert.equal(elements.inFileSearchInput.value, '');
  assert.equal(elements.inFileSearchCounter.textContent, '0/0');
  assert.equal(elements.readMount.children.length, 0);
});

test('selecting a deferred transcript deactivates search from the previous transcript', async () => {
  const elements = makeElements();
  const app = createSessionApp({
    elements,
    document: { createTextNode: (text) => ({ textContent: text }) },
    sessionApi: {
      async loadSessions() {
        return { ok: true, libraryPath: '/library', sessions: [
          { id: 'small', relativePath: 'codex/small.md', body: 'small', agent: 'codex' },
          { id: 'large', relativePath: 'codex/large.md', body: 'large transcript', agent: 'codex' },
        ] };
      },
    },
    sessionViewer: makeViewer(),
  });
  await app.initialize();
  app.selectSession('small');
  assert.equal(elements.inFileSearchToolbar.hidden, false);
  elements.inFileSearchInput.value = 'small';
  app.selectSession('large');
  assert.equal(elements.inFileSearchToolbar.hidden, true);
  assert.equal(elements.inFileSearchInput.value, '');
  assert.equal(elements.readMount.children.length, 0);
});

function refreshHarness() {
  const elements = makeElements();
  const viewer = makeViewer();
  const notes = [
    { id: 'a', relativePath: 'codex/a.md', title: 'A', body: 'first', agent: 'codex' },
    { id: 'b', relativePath: 'claude-code/b.md', title: 'B', body: 'second', agent: 'claude' },
  ];
  const successful = { ok: true, claude: { ok: true, imported: 2, skipped: 1, errors: 0 }, codex: { ok: true, imported: 3, skipped: 0, errors: 0 } };
  const api = {
    async loadSessions() { return { ok: true, libraryPath: '/synthetic/library', sessions: notes }; },
    async chooseLibrary() { return { ok: false, reason: 'cancelled' }; },
    async refreshSessions() { return successful; },
  };
  const app = createSessionApp({ elements, document: {}, sessionApi: api, sessionViewer: viewer });
  return { app, api, elements, viewer, notes, successful };
}

test('Refresh shows both counts and preserves the selected relative path with updated content', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.app.selectSession('a');
  h.api.loadSessions = async () => ({ ok: true, libraryPath: '/synthetic/library', sessions: [
    { ...h.notes[0], id: 'new-id', title: 'Updated', body: 'updated' },
  ] });
  assert.equal(await h.app.refreshSessions(), true);
  assert.equal(h.app.getState().selectedId, 'new-id');
  assert.equal(h.elements.readTitle.textContent, 'Updated');
  assert.equal(h.viewer.calls.renderedBodies.at(-1), 'updated');
  assert.equal(h.elements.refreshResult.hidden, false);
  assert.match(h.elements.refreshResult.textContent, /Claude：已导入 2，跳过 1，失败 0/);
  assert.match(h.elements.refreshResult.textContent, /Codex：已导入 3，跳过 0，失败 0/);
  assert.equal(h.elements.refreshResult.dataset.kind, 'status');
  await h.app.chooseLibrary();
  assert.equal(h.elements.refreshResult.hidden, false, 'cancellation keeps the result');
  h.api.chooseLibrary = async () => ({ ok: true, libraryPath: '/synthetic/other', sessions: [] });
  await h.app.chooseLibrary();
  assert.equal(h.elements.refreshResult.hidden, true);
});

test('partial success reloads the library and displays the successful counts and failed agent', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.app.selectSession('a');
  h.api.refreshSessions = async () => ({ ok: false, reason: 'import-error',
    claude: h.successful.claude, codex: { ok: false, reason: 'import-error' } });
  let loads = 0;
  h.api.loadSessions = async () => { loads++; return { ok: true, libraryPath: '/synthetic/library', sessions: h.notes }; };
  assert.equal(await h.app.refreshSessions(), false);
  assert.equal(loads, 1);
  assert.equal(h.app.getState().selectedId, 'a');
  assert.match(h.elements.refreshResult.textContent, /部分导入完成/);
  assert.match(h.elements.refreshResult.textContent, /Claude：已导入 2/);
  assert.match(h.elements.refreshResult.textContent, /Codex：导入失败，统计暂不可用/);
  assert.equal(h.elements.refreshResult.dataset.kind, 'error');
});

test('per-file error counts remain visible and cannot appear as unqualified success', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.api.refreshSessions = async () => ({ ok: false, reason: 'import-error',
    claude: { ok: false, reason: 'import-error', imported: 1, skipped: 2, errors: 3 }, codex: h.successful.codex });
  await h.app.refreshSessions();
  assert.match(h.elements.refreshResult.textContent, /部分导入完成/);
  assert.match(h.elements.refreshResult.textContent, /Claude：已导入 1，跳过 2，失败 3/);
});

test('source absence is explained, and a reload failure does not hide importer outcomes', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.api.refreshSessions = async () => ({ ok: true, claude: h.successful.claude,
    codex: { ok: true, imported: 0, skipped: 0, errors: 0, note: 'no-source' } });
  h.api.loadSessions = async () => ({ ok: false, reason: 'invalid-library' });
  assert.equal(await h.app.refreshSessions(), false);
  assert.match(h.elements.refreshResult.textContent, /Claude：已导入 2/);
  assert.match(h.elements.refreshResult.textContent, /未找到来源/);
  assert.match(h.elements.refreshResult.textContent, /无法重新读取会话库/);
  assert.equal(h.elements.refreshResult.dataset.kind, 'error');
});

test('Refresh preserves the session chosen during import and keeps large content deferred', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.app.selectSession('a');
  let release;
  h.api.refreshSessions = () => new Promise((resolve) => { release = resolve; });
  const refresh = h.app.refreshSessions();
  h.app.selectSession('b');
  h.api.loadSessions = async () => ({ ok: true, libraryPath: '/synthetic/library', sessions: [
    { ...h.notes[1], body: 'large updated transcript' },
  ] });
  release(h.successful);
  await refresh;
  assert.equal(h.app.getState().selectedId, 'b');
  assert.equal(h.elements.largeSessionNotice.hidden, false);
  assert.equal(h.elements.readMount.children.length, 0);
  assert.equal(h.elements.inFileSearchToolbar.hidden, true);
});

test('a removed selected session is not reopened after Refresh', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.app.selectSession('a');
  h.api.loadSessions = async () => ({ ok: true, libraryPath: '/synthetic/library', sessions: [h.notes[1]] });
  await h.app.refreshSessions();
  assert.equal(h.app.getState().selectedId, null);
  assert.equal(h.elements.readMount.children.length, 0);
});

for (const phase of ['import', 'reload']) {
  test(`switching libraries during ${phase} prevents stale Refresh UI and selection`, async () => {
    const h = refreshHarness();
    await h.app.initialize();
    let release;
    let reached;
    const started = new Promise((resolve) => { reached = resolve; });
    const method = phase === 'import' ? 'refreshSessions' : 'loadSessions';
    h.api[method] = () => new Promise((resolve) => { release = resolve; reached(); });
    const refresh = h.app.refreshSessions();
    await started;
    h.api.chooseLibrary = async () => ({ ok: true, libraryPath: '/synthetic/replacement', sessions: [h.notes[1]] });
    await h.app.chooseLibrary();
    const status = h.elements.status.textContent;
    release(phase === 'import' ? h.successful : { ok: true, libraryPath: '/synthetic/library', sessions: h.notes });
    await refresh;
    assert.equal(h.app.getState().libraryPath, '/synthetic/replacement');
    assert.equal(h.elements.status.textContent, status);
    assert.equal(h.elements.refreshResult.hidden, true);
    assert.equal(h.elements.refreshButton.disabled, false);
  });
}

test('preflight or transport errors retain the library and show no fabricated counts', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.app.selectSession('a');
  h.api.loadSessions = async () => { throw new Error('must not reload'); };
  h.api.refreshSessions = async () => ({ ok: false, reason: 'in-progress' });
  assert.equal(await h.app.refreshSessions(), false);
  assert.match(h.elements.refreshResult.textContent, /正在导入/);
  h.api.refreshSessions = async () => { throw new Error('private transport detail'); };
  assert.equal(await h.app.refreshSessions(), false);
  assert.equal(h.app.getState().selectedId, 'a');
  assert.match(h.elements.refreshResult.textContent, /导入失败/);
  assert.doesNotMatch(h.elements.refreshResult.textContent, /private transport detail|imported 0/);
});

test('both failed agents still rescan and report failures without a partial-success claim', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  let loads = 0;
  h.api.loadSessions = async () => { loads++; return { ok: true, libraryPath: '/synthetic/library', sessions: h.notes }; };
  h.api.refreshSessions = async () => ({ ok: false, reason: 'import-error',
    claude: { ok: false, reason: 'import-error' }, codex: { ok: false, reason: 'import-error' } });
  assert.equal(await h.app.refreshSessions(), false);
  assert.equal(loads, 1);
  assert.match(h.elements.refreshResult.textContent, /^导入失败/);
  assert.doesNotMatch(h.elements.refreshResult.textContent, /Partial success|imported 0/);
  assert.equal(h.elements.refreshButton.disabled, false);
});

test('a rejected reload retains importer counts and sanitizes the thrown error', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.api.loadSessions = async () => { throw new Error('sensitive reload path'); };
  assert.equal(await h.app.refreshSessions(), false);
  assert.match(h.elements.refreshResult.textContent, /Claude：已导入 2/);
  assert.match(h.elements.refreshResult.textContent, /无法重新读取会话库/);
  assert.doesNotMatch(h.elements.refreshResult.textContent, /sensitive reload path/);
});

test('a chooser completing at reload completion cannot be overwritten by Refresh selection or status', async () => {
  const h = refreshHarness();
  await h.app.initialize();
  h.app.selectSession('a');
  let choosing;
  h.api.chooseLibrary = async () => ({ ok: true, libraryPath: '/synthetic/replacement', sessions: h.notes });
  h.api.loadSessions = async () => {
    queueMicrotask(() => { choosing = h.app.chooseLibrary(); });
    return { ok: true, libraryPath: '/synthetic/library', sessions: h.notes };
  };
  await h.app.refreshSessions();
  await choosing;
  assert.equal(h.app.getState().libraryPath, '/synthetic/replacement');
  assert.equal(h.app.getState().selectedId, null);
  assert.equal(h.elements.refreshResult.hidden, true);
  assert.equal(h.elements.status.textContent, '已载入 2 个会话。');
});


test('reader list filters compose metadata and favorites without rendering bodies', async () => {
  const elements = makeElements(), viewer = makeViewer();
  const sessions = [
    { id: 'a', relativePath: 'a.md', title: 'Alpha', agent: 'codex', body: 'short' },
    { id: 'b', relativePath: 'b.md', title: 'Beta', agent: 'claude', body: 'short' },
  ];
  const app = createSessionApp({ elements, document: { createTextNode: text => ({ textContent: text }) },
    sessionApi: { chooseLibrary: async () => ({ ok: true, libraryPath: '/synthetic', sessions }) },
    storage: makeStorage(), sessionViewer: viewer });
  await app.chooseLibrary();
  app.setListFilter({ agent: 'claude', query: '', favoritesOnly: false });
  assert.deepEqual(viewer.calls.trees.at(-1).tree.codex[0].items.map(x => x.id), ['b']);
  app.toggleFavorite('b.md');
  app.setListFilter({ agent: 'all', query: 'beta', favoritesOnly: true });
  assert.deepEqual(viewer.calls.trees.at(-1).tree.codex[0].items.map(x => x.id), ['b']);
  app.toggleSelectedFavorite();
  assert.equal(app.getSelectedFavorite(), false);
  app.selectSession('b');
  assert.equal(app.getSelectedFavorite(), true);
  app.toggleSelectedFavorite();
  assert.equal(app.getSelectedFavorite(), false);
  assert.equal(viewer.calls.trees.at(-1).tree.codex[0].items.length, 0);
  assert.equal(elements.emptyState.hidden, false);
});
