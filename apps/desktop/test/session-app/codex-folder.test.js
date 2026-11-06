'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionApp } = require('../../lib/session-app');
const { makeFakeDocument, flattenText } = require('../session-viewer/read-fake-document');
const { createFavoritesController } = require('../../lib/session-viewer/favorites');
const { renderStructuredConversation } = require('../../lib/session-viewer/structured-conversation');

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';

function harness() {
  const document = makeFakeDocument();
  const originalCreate = document.createElement;
  document.createElement = (tag) => {
    const value = originalCreate(tag);
    value.hidden = false; value.disabled = false; value.value = ''; value.dataset = {};
    value.listeners = {};
    value.addEventListener = (type, handler) => { value.listeners[type] = handler; };
    value.click = () => value.listeners.click?.();
    return value;
  };
  const elements = {};
  for (const name of [
    'chooseLibraryButton', 'openCodexFileButton', 'openCodexFolderButton',
    'reloadCodexFileButton', 'reloadCodexFolderButton', 'rescanCodexFolderButton',
    'cancelCodexFolderScanButton', 'backToLibraryButton', 'directDiagnostics',
    'librarySearch', 'folderFilter', 'folderFilterInput', 'folderDiagnostics', 'folderPager',
    'folderPageStatus', 'folderPrevPageButton', 'folderNextPageButton',
    'refreshButton', 'libraryPath', 'status', 'libraryWarning', 'refreshResult',
    'sessionList', 'globalSearchInput', 'globalSearchResults', 'globalSearchBanner',
    'readTitle', 'readMount', 'inFileSearchToolbar', 'inFileSearchInput',
    'inFileSearchPrev', 'inFileSearchNext', 'inFileSearchCounter',
    'largeSessionNotice', 'loadLargeSessionButton', 'emptyState',
  ]) elements[name] = document.createElement(name.includes('Button') ? 'button' : 'div');
  const storageValues = new Map();
  const calls = { imports: 0, folderLoads: 0, folderReloads: 0 };
  const conversation = { messages: [{ role: 'user', text: 'Synthetic body' }], diagnostics: { malformedRecords: 0, unparsedFinalRecord: 0, unsupportedRecords: 0, omittedContentBlocks: 0, excludedRecords: 0 } };
  const catalog = { layout: 'full', sourceId: 'source-a', generation: 1, selectedEntryId: null, diagnostics: { skipped: 0, errors: 0, duplicates: 0, indexErrors: 0 }, entries: [{ entryId: ENTRY_ID, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Folder session', updatedAt: 1, bytes: 2, area: 'active' }] };
  const api = {
    loadSessions: async () => ({ ok: true, libraryPath: '/synthetic/library', sessions: [] }),
    chooseLibrary: async () => ({ ok: false, reason: 'cancelled' }),
    chooseCodexFile: async () => ({ ok: false, reason: 'cancelled' }),
    reloadCodexFile: async () => ({ ok: false, reason: 'no-source' }),
    refreshSessions: async () => { calls.imports += 1; return { ok: true }; },
    chooseCodexFolder: async () => ({ ok: true, catalog }),
    rescanCodexFolder: async () => ({ ok: true, catalog }),
    cancelCodexFolderScan: async () => ({ ok: true }),
    loadCodexCatalogEntry: async (entryId) => { calls.folderLoads += 1; return { ok: true, generation: 1, entryId, session: { name: 'Folder session', sourceBytes: 2, conversation } }; },
    reloadCodexCatalogEntry: async () => { calls.folderReloads += 1; return { ok: true, generation: 1, entryId: ENTRY_ID, session: { name: 'Folder session', sourceBytes: 2, conversation } }; },
  };
  const viewer = {
    createFavoritesController,
    createInFileSearchToolbar: () => ({ onReadActivated() {}, onReadDeactivated() {}, refreshAfterRender() {}, searchAndReveal() {} }),
    createGroupedListRenderer: () => ({ render() {} }),
    groupAndSort: () => ({}), renderStructuredConversation,
    MIN_GLOBAL_QUERY_LEN: 2, renderGlobalResults() {},
  };
  const storage = { getItem: (key) => storageValues.get(key) || null, setItem: (key, value) => storageValues.set(key, String(value)) };
  const app = createSessionApp({ elements, document, sessionApi: api, sessionViewer: viewer, storage });
  return { app, api, calls, catalog, document, elements };
}

test('folder mode browses metadata, loads by opaque ID, disables Refresh, and returns to the saved library', async () => {
  const h = harness();
  await h.app.initialize();
  assert.equal(await h.app.chooseCodexFolder(), true);
  assert.equal(h.app.getState().sourceMode, 'folder');
  assert.equal(h.elements.refreshButton.disabled, true);
  assert.equal(h.elements.librarySearch.hidden, true);
  assert.equal(h.elements.folderFilter.hidden, false);
  assert.equal(h.elements.sessionList.hidden, false);
  assert.equal(h.elements.libraryPath.textContent.includes('/synthetic'), false);
  assert.match(flattenText(h.elements.sessionList), /Folder session/);

  assert.equal(await h.app.openCodexCatalogEntry(ENTRY_ID), true);
  assert.equal(h.calls.folderLoads, 1);
  assert.match(flattenText(h.elements.readMount), /Synthetic body/);
  assert.equal(await h.app.reloadCodexFolderEntry(), true);
  assert.equal(h.calls.folderReloads, 1);
  assert.equal(await h.app.refreshSessions(), false);
  assert.equal(h.calls.imports, 0);

  assert.equal(await h.app.backToLibrary(), true);
  assert.equal(h.app.getState().sourceMode, 'library');
  assert.equal(h.elements.folderFilter.hidden, true);
  assert.equal(h.elements.librarySearch.hidden, false);
  assert.equal(h.elements.refreshButton.disabled, false);
});
