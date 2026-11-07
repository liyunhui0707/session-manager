// Stage S5 — favorites controller for AI Sessions.
//
// The pure helpers (loadFavoritesFromStorage,
// saveFavoritesToStorage, toggleFavorite) remain on the api for
// direct testing; the convenience controller wraps them with an
// in-memory Set + an injected storage handle.
//
// Storage is namespaced to this standalone application.
//
// IIFE-wrapped + dual CJS/window export.

'use strict';

(function () {

const DEFAULT_KEY = 'aiSessionManager.favorites';

function loadFavoritesFromStorage(storage, key) {
  if (!storage) return new Set();
  const useKey = key || DEFAULT_KEY;
  try {
    const raw = storage.getItem(useKey);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x) => typeof x === 'string'));
  } catch (_e) {
    return new Set();
  }
}

function saveFavoritesToStorage(storage, set, key) {
  if (!storage) return;
  const useKey = key || DEFAULT_KEY;
  try {
    storage.setItem(useKey, JSON.stringify([...set]));
  } catch (_e) {
    // quota exceeded / unavailable — silently no-op (matches upstream)
  }
}

function toggleFavorite(set, relPath) {
  const next = new Set(set);
  if (next.has(relPath)) {
    next.delete(relPath);
  } else {
    next.add(relPath);
  }
  return next;
}

function createFavoritesController(opts) {
  opts = opts || {};
  const storage = opts.storage || null;
  const key = opts.key || DEFAULT_KEY;
  let set = loadFavoritesFromStorage(storage, key);
  let stored = JSON.stringify([...set]);
  function reload() {
    if (!storage) return;
    const next = loadFavoritesFromStorage(storage, key);
    const value = JSON.stringify([...next]);
    // Preserve in-memory changes if a quota failure left storage unchanged.
    if (value !== stored) { stored = value; set = next; }
  }

  return {
    reload,
    isFavorite(relativePath) {
      if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
      return set.has(relativePath);
    },
    toggle(relativePath) {
      if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
      reload();
      set = toggleFavorite(set, relativePath);
      saveFavoritesToStorage(storage, set, key);
      return set.has(relativePath);
    },
    getAll() {
      return new Set(set);
    },
    size() {
      return set.size;
    },
    clear() {
      set = new Set();
      saveFavoritesToStorage(storage, set, key);
    },
  };
}

const api = {
  FAVORITES_KEY: DEFAULT_KEY,
  loadFavoritesFromStorage,
  saveFavoritesToStorage,
  toggleFavorite,
  createFavoritesController,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
