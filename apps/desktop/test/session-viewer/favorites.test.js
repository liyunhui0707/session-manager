/* Stage S5 — unit tests for favorites.js
   Run: node --test test/session-viewer/favorites.test.js  */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Favorites = require('../../lib/session-viewer/favorites');

function makeMockStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  let throwOnSet = false;
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (throwOnSet) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    _map: map,
    _setThrowOnSet(b) { throwOnSet = b; },
  };
}

// ---------- pure helpers ----------

test('T-S5-1 loadFavoritesFromStorage returns empty Set with null storage', () => {
  const result = Favorites.loadFavoritesFromStorage(null);
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

test('T-S5-1b loadFavoritesFromStorage parses JSON array into Set', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '["a","b","c"]',
  });
  const result = Favorites.loadFavoritesFromStorage(storage);
  assert.equal(result.size, 3);
  assert.ok(result.has('a'));
  assert.ok(result.has('b'));
  assert.ok(result.has('c'));
});

test('T-S5-1c loadFavoritesFromStorage filters out non-strings', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '["valid", 42, null, true, "ok"]',
  });
  const result = Favorites.loadFavoritesFromStorage(storage);
  assert.equal(result.size, 2);
  assert.ok(result.has('valid'));
  assert.ok(result.has('ok'));
});

test('T-S5-1d loadFavoritesFromStorage tolerates garbage JSON', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': 'not-json',
  });
  const result = Favorites.loadFavoritesFromStorage(storage);
  assert.equal(result.size, 0);
});

test('T-S5-1e loadFavoritesFromStorage tolerates non-array root', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '{"k":"v"}',
  });
  const result = Favorites.loadFavoritesFromStorage(storage);
  assert.equal(result.size, 0);
});

test('T-S5-2 saveFavoritesToStorage writes JSON array', () => {
  const storage = makeMockStorage();
  Favorites.saveFavoritesToStorage(storage, new Set(['x', 'y']));
  const stored = storage._map.get('aiSessionManager.favorites');
  const parsed = JSON.parse(stored);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.ok(parsed.includes('x'));
  assert.ok(parsed.includes('y'));
});

test('T-S5-2b saveFavoritesToStorage swallows quota errors', () => {
  const storage = makeMockStorage();
  storage._setThrowOnSet(true);
  // Must NOT throw.
  Favorites.saveFavoritesToStorage(storage, new Set(['x']));
});

test('T-S5-2c saveFavoritesToStorage no-ops with null storage', () => {
  Favorites.saveFavoritesToStorage(null, new Set(['x']));
});

test('T-S5-3 toggleFavorite adds when absent', () => {
  const initial = new Set(['a']);
  const next = Favorites.toggleFavorite(initial, 'b');
  assert.equal(next.size, 2);
  assert.ok(next.has('a'));
  assert.ok(next.has('b'));
  // Pure: initial unchanged.
  assert.equal(initial.size, 1);
});

test('T-S5-3b toggleFavorite removes when present', () => {
  const initial = new Set(['a', 'b']);
  const next = Favorites.toggleFavorite(initial, 'a');
  assert.equal(next.size, 1);
  assert.ok(!next.has('a'));
  assert.ok(next.has('b'));
});

// ---------- controller ----------

test('T-S5-4 controller loads existing favorites at construction', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '["preexisting/path.md"]',
  });
  const ctrl = Favorites.createFavoritesController({ storage });
  assert.equal(ctrl.isFavorite('preexisting/path.md'), true);
  assert.equal(ctrl.isFavorite('other/path.md'), false);
  assert.equal(ctrl.size(), 1);
});

test('T-S5-4b controller.toggle adds and persists', () => {
  const storage = makeMockStorage();
  const ctrl = Favorites.createFavoritesController({ storage });
  const result = ctrl.toggle('foo/bar.md');
  assert.equal(result, true);
  assert.equal(ctrl.isFavorite('foo/bar.md'), true);
  // Persisted
  const parsed = JSON.parse(storage._map.get('aiSessionManager.favorites'));
  assert.deepEqual(parsed, ['foo/bar.md']);
});

test('T-S5-4c controller.toggle removes and persists', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '["foo/bar.md"]',
  });
  const ctrl = Favorites.createFavoritesController({ storage });
  const result = ctrl.toggle('foo/bar.md');
  assert.equal(result, false);
  assert.equal(ctrl.isFavorite('foo/bar.md'), false);
  const parsed = JSON.parse(storage._map.get('aiSessionManager.favorites'));
  assert.deepEqual(parsed, []);
});

test('T-S5-4d controller.toggle rejects empty/non-string path', () => {
  const storage = makeMockStorage();
  const ctrl = Favorites.createFavoritesController({ storage });
  assert.equal(ctrl.toggle(''), false);
  assert.equal(ctrl.toggle(null), false);
  assert.equal(ctrl.size(), 0);
});

test('T-S5-4e controller.isFavorite rejects empty/non-string path', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '["a/b.md"]',
  });
  const ctrl = Favorites.createFavoritesController({ storage });
  assert.equal(ctrl.isFavorite(''), false);
  assert.equal(ctrl.isFavorite(null), false);
});

test('T-S5-5 controller.clear empties the set + persists', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '["a","b","c"]',
  });
  const ctrl = Favorites.createFavoritesController({ storage });
  ctrl.clear();
  assert.equal(ctrl.size(), 0);
  const parsed = JSON.parse(storage._map.get('aiSessionManager.favorites'));
  assert.deepEqual(parsed, []);
});

test('T-S5-5a controller.getAll returns a defensive copy', () => {
  const storage = makeMockStorage({
    'aiSessionManager.favorites': '["a"]',
  });
  const ctrl = Favorites.createFavoritesController({ storage });
  const snap = ctrl.getAll();
  snap.add('mutation');
  assert.equal(ctrl.size(), 1, 'internal set must not be mutated by callers');
});

test('T-S5-5b controller honours custom key', () => {
  const storage = makeMockStorage({
    'custom.key': '["x"]',
  });
  const ctrl = Favorites.createFavoritesController({ storage, key: 'custom.key' });
  assert.equal(ctrl.isFavorite('x'), true);
  ctrl.toggle('y');
  const parsed = JSON.parse(storage._map.get('custom.key'));
  assert.ok(parsed.includes('y'));
});

test('T-S5-5c controller swallows quota error on toggle', () => {
  const storage = makeMockStorage();
  const ctrl = Favorites.createFavoritesController({ storage });
  storage._setThrowOnSet(true);
  // Must not throw.
  const result = ctrl.toggle('a/b.md');
  // In-memory state still updated even if persistence fails.
  assert.equal(result, true);
  assert.equal(ctrl.isFavorite('a/b.md'), true);
});
