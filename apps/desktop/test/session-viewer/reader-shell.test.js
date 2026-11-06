'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReaderShell, normalizePreferences } = require('../../lib/session-viewer/reader-shell');
function harness() {
  const nodes = new Map(), values = new Map(), events = {};
  const document = { documentElement: { dataset: {} }, activeElement: null,
    querySelectorAll: () => [], addEventListener: (name, fn) => { events[name] = fn; },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { id, hidden: false, disabled: false, value: '', textContent: '', dataset: {}, open: false, children: [],
        listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
        setAttribute(name, value) { this[name] = value; },
        focus() { document.activeElement = this; }, select() {},
        showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); },
        click() { this.listeners.click?.(); }, querySelector: () => null,
      });
      return nodes.get(id);
    } };
  let state = { sourceMode: 'folder', folder: { entries: [{ title: 'Example' }], selectedEntryId: 'opaque' } };
  const calls = [];
  const app = { getState: () => state, isBusy: () => false, getSelectedFavorite: () => false,
    setListFilter: filter => calls.push(filter), toggleSelectedFavorite: () => calls.push('favorite') };
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  document.getElementById('readTitle').textContent = 'Example';
  const shell = createReaderShell({ document, app, storage });
  return { document, shell, calls, values, events, node: document.getElementById, setState: next => { state = next; } };
}
test('reader appearance preferences whitelist values and never persist source or conversation data', () => {
  assert.deepEqual(normalizePreferences({ theme: 'evil', font: 'large', width: 'wide', path: '/private', query: 'secret' }),
    { theme: 'system', font: 'large', width: 'wide' });
  const h = harness();
  h.shell.setPreference('theme', 'dark');
  h.shell.setPreference('font', 'large');
  h.shell.setPreference('path', '/private');
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.deepEqual(JSON.parse([...h.values.values()][0]), { theme: 'dark', font: 'large', width: 'comfortable' });
});

test('folder counts describe unarchived conversations, not currently active processes', () => {
  const h = harness();
  h.shell.sync();
  assert.equal(h.node('currentSourceChip').textContent, 'Codex · 未归档对话');
  assert.equal(h.node('sourceSubtitle').textContent, '1 个未归档对话 · 自动更新');
});
test('search routes to the active source and shortcuts preserve IME composition', () => {
  const h = harness();
  h.node('searchLaunch').click();
  assert.equal(h.node('searchDialog').open, true);
  assert.equal(h.document.activeElement.id, 'codexSearchInput');
  h.node('searchDialog').close();
  h.setState({ sourceMode: 'library', sessions: [], folder: {} });
  h.shell.sync();
  h.node('searchLaunch').click();
  assert.equal(h.document.activeElement.id, 'globalSearchInput');
  h.node('searchDialog').close();
  let prevented = false;
  h.events.keydown({ key: 'k', metaKey: true, isComposing: true, preventDefault() { prevented = true; } });
  assert.equal(h.node('searchDialog').open, false);
  assert.equal(prevented, false);
});
test('dialogs restore focus and find can be explicitly closed without losing reader state', () => {
  const h = harness();
  h.node('sourcesButton').focus(); h.node('sourcesButton').click();
  h.node('sourcesDialog').close();
  assert.equal(h.document.activeElement.id, 'sourcesButton');
  h.node('findButton').click();
  assert.equal(h.document.documentElement.dataset.find, 'open');
  assert.equal(h.document.activeElement.id, 'inFileSearchInput');
  h.node('findClose').click();
  assert.equal(h.document.documentElement.dataset.find, 'closed');
  assert.equal(h.node('readTitle').textContent, 'Example');
});
test('favorite control does not open bodies and source switches reset stale list filters', () => {
  const h = harness();
  h.node('favoritesFilter').click();
  assert.equal(h.calls.at(-1).favoritesOnly, true);
  h.node('readerFavorite').click();
  assert.equal(h.calls.at(-1), 'favorite');
  h.setState({ sourceMode: 'codex', readerId: 'new', folder: {} }); h.shell.sync();
  assert.equal(h.node('readerFavorite').disabled, true);
  assert.equal(h.node('favoritesFilter').getAttribute?.('aria-pressed') || h.node('favoritesFilter')['aria-pressed'], 'false');
});

test('body font shortcuts cover seven sizes, clamp, reset and do not affect typing', () => {
  const h = harness(); let prevented = 0;
  const key = (key, target) => h.events.keydown({ key, metaKey: true, target, preventDefault() { prevented++; } });
  key('+'); key('='); key('+'); key('+'); key('+'); key('+');
  assert.equal(h.document.documentElement.dataset.font, 'xxxxlarge');
  key('-'); assert.equal(h.document.documentElement.dataset.font, 'xxxlarge');
  key('0'); assert.equal(h.document.documentElement.dataset.font, 'medium');
  key('+', { tagName: 'INPUT' }); assert.equal(h.document.documentElement.dataset.font, 'medium');
  assert.equal(prevented, 8);
  for (let i=0;i<4;i++) key('-');
  assert.equal(h.document.documentElement.dataset.font, 'small');
});
test('header shows structured cwd and repeated source and footer labels stay hidden', () => {
  const h = harness();
  h.setState({ sourceMode: 'folder', cwd: '/synthetic/project', folder: { entries: [] } }); h.shell.sync();
  assert.equal(h.node('readerMeta').textContent, '/synthetic/project');
  assert.equal(h.node('readerMeta').title, '/synthetic/project');
  assert.equal(h.node('currentSourceChip').hidden, true);
  assert.equal(h.node('readerPosition').textContent, '');
});
