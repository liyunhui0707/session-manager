/* Stage S5 — headless tests for grouped-list-renderer.js
   Run: node --test test/session-viewer/grouped-list-renderer.test.js  */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGroupedListRenderer } = require('../../lib/session-viewer/grouped-list-renderer');
const Grouping = require('../../lib/session-viewer/grouping');
const Favorites = require('../../lib/session-viewer/favorites');
const { makeFakeDocument, findAllByTag, findByTag } = require('./read-fake-document');

function findByClass(node, cls) {
  if (!node) return null;
  if (node.attrs && String(node.attrs.class || '').split(' ').includes(cls)) return node;
  if (node.children) {
    for (const c of node.children) {
      const found = findByClass(c, cls);
      if (found) return found;
    }
  }
  return null;
}
function findAllByClass(node, cls) {
  const out = [];
  function walk(n) {
    if (!n) return;
    if (n.attrs && String(n.attrs.class || '').split(' ').includes(cls)) out.push(n);
    if (n.children) n.children.forEach(walk);
  }
  walk(node);
  return out;
}

function makeHarness() {
  const doc = makeFakeDocument();
  const container = doc.createElement('div');
  const storage = new Map();
  const mockStorage = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
  };
  const favoritesController = Favorites.createFavoritesController({ storage: mockStorage });
  const rowClicks = [];
  const starClicks = [];
  const headerToggles = [];
  const collapsed = new Set();
  const renderer = createGroupedListRenderer({
    container,
    document: doc,
    favoritesController,
    onRowClick: (id) => rowClicks.push(id),
    onStarClick: (rel) => starClicks.push(rel),
    onHeaderToggle: (gk) => headerToggles.push(gk),
    isCollapsed: (gk) => collapsed.has(gk),
  });
  return { doc, container, favoritesController, renderer, rowClicks, starClicks, headerToggles, collapsed };
}

function fixedToday() { return new Date(2026, 4, 25, 12, 0, 0); }

function sampleTree(favoritesController) {
  const items = [
    { id: 'c1', title: 'Codex one',  relativePath: 'Inbox/AI Chats/codex/a.md', agent: 'codex', mtime: fixedToday() },
    { id: 'c2', title: 'Codex two',  relativePath: 'Inbox/AI Chats/codex/b.md', agent: 'codex', mtime: fixedToday() },
    { id: 'cl1', title: 'Claude one', relativePath: 'Inbox/AI Chats/claude-code/x.md', agent: 'claude', mtime: fixedToday() },
    { id: 'o1', title: 'Other one',  relativePath: 'Inbox/AI Chats/misc/q.md',  agent: 'other',  mtime: fixedToday() },
  ];
  return Grouping.groupAndSort(items, {
    today: fixedToday(),
    isFavorite: (it) => favoritesController.isFavorite(it.relativePath),
  });
}

// ---------- T-S5-16..20 ----------

test('T-S5-16 builds 3 section headers when no favorites (codex/claude/other)', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  const headers = findAllByClass(h.container, 'session-group-header');
  assert.equal(headers.length, 3);
  const keys = headers.map((he) => he.attrs['data-group-key']);
  assert.deepEqual(keys, ['codex', 'claude', 'other']);
});

test('T-S5-17 builds 4 section headers when there is at least one favorite (favorite first)', () => {
  const h = makeHarness();
  h.favoritesController.toggle('Inbox/AI Chats/codex/a.md');
  h.renderer.render(sampleTree(h.favoritesController), null);
  const headers = findAllByClass(h.container, 'session-group-header');
  const keys = headers.map((he) => he.attrs['data-group-key']);
  assert.deepEqual(keys, ['favorite', 'codex', 'claude', 'other']);
});

test('T-S5-17a favorite group body is FLAT (rows directly, no bucket wrappers) — round-2 QA fix', () => {
  const h = makeHarness();
  h.favoritesController.toggle('Inbox/AI Chats/codex/a.md');
  h.renderer.render(sampleTree(h.favoritesController), null);
  // Find the favorite group
  const favGroup = findAllByClass(h.container, 'session-group')
    .find((g) => g.attrs['data-group-key'] === 'favorite');
  assert.ok(favGroup, 'favorite group should be rendered');
  const favBody = favGroup.children[1];
  assert.equal(favBody.attrs.class, 'session-group-body');
  // The body's direct children must be `.session-row`, not `.session-bucket`.
  const directRows = (favBody.children || []).filter(
    (c) => c.attrs && String(c.attrs.class || '').split(' ').includes('session-row'),
  );
  const directBuckets = (favBody.children || []).filter(
    (c) => c.attrs && String(c.attrs.class || '').split(' ').includes('session-bucket'),
  );
  assert.equal(directBuckets.length, 0, 'favorite group must NOT have bucket headers');
  assert.equal(directRows.length, 1, 'one favorite row directly in body');
});

test('T-S5-18 bucket headers nested inside agent group bodies (today/etc.)', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  const codexGroup = findByClass(h.container, 'session-group');
  const codexBody = codexGroup.children[1];
  assert.equal(codexBody.attrs.class, 'session-group-body');
  const buckets = findAllByClass(codexBody, 'session-bucket');
  assert.ok(buckets.length >= 1);
  const bucketHeader = findByClass(buckets[0], 'session-bucket-header');
  // Round-3 QA fix (issue B): bucket headers are now clickable
  // chevron / label / count rows. Find the label span by class.
  const label = findByClass(bucketHeader, 'session-bucket-label');
  assert.ok(label, 'bucket header must have a .session-bucket-label child');
  assert.equal(label.children[0].textContent, '今天');
});

// ---------- Round-3 QA fix (issue B): bucket-level collapse ----------

test('T-S5-18a bucket header is clickable + onBucketToggle fires with (groupKey, layerId)', () => {
  const h = makeHarness();
  const calls = [];
  const renderer = createGroupedListRenderer({
    container: h.container,
    document: h.doc,
    favoritesController: h.favoritesController,
    onRowClick: () => {},
    onStarClick: () => {},
    onHeaderToggle: () => {},
    isCollapsed: () => false,
    onBucketToggle: (gk, lid) => calls.push([gk, lid]),
    isBucketCollapsed: () => false,
  });
  renderer.render(sampleTree(h.favoritesController), null);
  const codexGroup = findByClass(h.container, 'session-group');
  const codexBody = codexGroup.children[1];
  const buckets = findAllByClass(codexBody, 'session-bucket');
  const bucketHeader = findByClass(buckets[0], 'session-bucket-header');
  bucketHeader.__onClick();
  assert.deepEqual(calls, [['codex', 'today']]);
});

test('T-S5-18b isBucketCollapsed=true hides bucket rows + flips chevron', () => {
  const h = makeHarness();
  const renderer = createGroupedListRenderer({
    container: h.container,
    document: h.doc,
    favoritesController: h.favoritesController,
    onRowClick: () => {},
    onStarClick: () => {},
    onHeaderToggle: () => {},
    isCollapsed: () => false,
    onBucketToggle: () => {},
    isBucketCollapsed: (gk, lid) => gk === 'codex' && lid === 'today',
  });
  renderer.render(sampleTree(h.favoritesController), null);
  const codexGroup = findByClass(h.container, 'session-group');
  const codexBody = codexGroup.children[1];
  const buckets = findAllByClass(codexBody, 'session-bucket');
  // bucket children should be [header] only — rows are skipped when collapsed.
  assert.equal(buckets[0].children.length, 1);
  const header = buckets[0].children[0];
  const cls = String(header.attrs.class).split(' ');
  assert.ok(cls.includes('session-bucket-header--collapsed'));
  const chev = findByClass(header, 'session-bucket-chevron');
  assert.equal(chev.children[0].textContent, '▸');
});

test('T-S5-19 each row has a star + title; no innerHTML writes', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  const rows = findAllByClass(h.container, 'session-row');
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const star = findByClass(row, 'session-star');
    assert.ok(star);
    const title = findByClass(row, 'session-row-title');
    assert.ok(title);
  }
  assert.equal(h.doc.unsafeApiWrites, 0);
});

test('T-S5-20 favorite row gets star--on; non-favorite gets the empty star', () => {
  const h = makeHarness();
  h.favoritesController.toggle('Inbox/AI Chats/codex/a.md');
  h.renderer.render(sampleTree(h.favoritesController), null);
  const stars = findAllByClass(h.container, 'session-star');
  const filled = stars.filter((s) =>
    String(s.attrs.class).split(' ').includes('session-star--on'),
  );
  assert.equal(filled.length, 2, 'favorite group + the favorite row in codex group both render ★');
  // Total stars = 4 codex/claude/other rows + 1 favorite-section duplicate = 5.
  assert.equal(stars.length, 5);
});

// ---------- T-S5-21..23 ----------

test('T-S5-21 star click invokes onStarClick with relativePath', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  const star = findByClass(h.container, 'session-star');
  star.__onClick();
  assert.equal(h.starClicks.length, 1);
  // First star is in codex group (alphabetical first)
  assert.ok(typeof h.starClicks[0] === 'string');
  assert.ok(h.starClicks[0].startsWith('Inbox/AI Chats/'));
});

test('T-S5-22 row click invokes onRowClick with noteId', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  const row = findByClass(h.container, 'session-row');
  row.__onClick();
  assert.equal(h.rowClicks.length, 1);
  assert.ok(['c1', 'c2'].includes(h.rowClicks[0]));
});

test('T-S5-23 header click invokes onHeaderToggle with group key', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  const headers = findAllByClass(h.container, 'session-group-header');
  headers[0].__onClick();
  assert.deepEqual(h.headerToggles, ['codex']);
});

// ---------- T-S5-24..25 ----------

test('T-S5-24 isCollapsed=true hides body + flips chevron', () => {
  const h = makeHarness();
  h.collapsed.add('codex');
  h.renderer.render(sampleTree(h.favoritesController), null);
  const codexGroup = findByClass(h.container, 'session-group');
  const header = codexGroup.children[0];
  const body = codexGroup.children[1];
  const cls = String(header.attrs.class).split(' ');
  assert.ok(cls.includes('session-group-header--collapsed'));
  const chev = findByClass(header, 'session-group-chevron');
  assert.equal(chev.children[0].textContent, '▸');
  assert.equal(body.hidden, true);
});

test('T-S5-25 selected note row gets session-row--active', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), 'c2');
  const active = findAllByClass(h.container, 'session-row--active');
  assert.equal(active.length, 1);
  assert.equal(active[0].attrs['data-note-id'], 'c2');
});

// ---------- T-S5-26 ----------

test('T-S5-26 renderer never writes innerHTML across multiple renders', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  h.favoritesController.toggle('Inbox/AI Chats/codex/a.md');
  h.renderer.render(sampleTree(h.favoritesController), 'cl1');
  h.renderer.render(sampleTree(h.favoritesController), null);
  assert.equal(h.doc.unsafeApiWrites, 0);
});

// ---------- Misc ----------

test('renderer is idempotent — second render replaces first', () => {
  const h = makeHarness();
  h.renderer.render(sampleTree(h.favoritesController), null);
  const firstCount = h.container.children.length;
  h.renderer.render(sampleTree(h.favoritesController), null);
  const secondCount = h.container.children.length;
  assert.equal(secondCount, firstCount);
});

test('renderer with empty tree paints nothing', () => {
  const h = makeHarness();
  h.renderer.render({ codex: [], claude: [], other: [], counts: { codex: {sessions:0}, claude:{sessions:0}, other:{sessions:0} } }, null);
  assert.equal(h.container.children.length, 0);
});

test('controller throws on missing required opts', () => {
  assert.throws(() => createGroupedListRenderer({}));
  assert.throws(() => createGroupedListRenderer({ container: {} }));
});
