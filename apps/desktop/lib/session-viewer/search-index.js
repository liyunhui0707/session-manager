// Stage S4 — cross-session index + scoring + result rendering.
//
// Verbatim port of Local-Web-Server/public/search-utils.js lines
// 155-334. The in-file DOM walk + highlighting helpers live in
// `search-dom.js` (kept under the 300-line cap).
//
// Index entry shape:   { id, title, mtime, textContent }
// textContent is a string or an array of separately searchable reader text runs.
// Search result shape: { id, title, mtime, matchCount }
// Sort order:          matchCount desc, then mtime desc.
//
// IIFE-wrapped + dual CJS/window export.

'use strict';

(function () {

const MIN_GLOBAL_QUERY_LEN = 2;

function nextMatchIndex(current, total) {
  if (total <= 0) return 0;
  return (current + 1) % total;
}

function prevMatchIndex(current, total) {
  if (total <= 0) return 0;
  return (current - 1 + total) % total;
}

function countSubstringOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  if (Array.isArray(haystack)) {
    return haystack.reduce((sum, run) => sum + countSubstringOccurrences(run, needle), 0);
  }
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let i = 0;
  while (i <= h.length - n.length) {
    const f = h.indexOf(n, i);
    if (f === -1) break;
    count += 1;
    i = f + n.length;
  }
  return count;
}

async function buildGlobalIndex(items, fetchFn, extractText, isSupported, opts) {
  const concurrency = (opts && opts.concurrency) || 4;
  const supported = items.filter((it) => isSupported(it));
  const out = [];
  let cursor = 0;
  async function worker() {
    while (cursor < supported.length) {
      const myIdx = cursor;
      cursor += 1;
      const item = supported[myIdx];
      try {
        const body = await fetchFn(item);
        const text = extractText(body && body.content !== undefined ? body.content : '');
        out.push({
          id: item.id,
          title: item.title,
          mtime: item.sourceMtime || 0,
          textContent: text || '',
        });
      } catch (_e) {
        // skip on failure (timeout, network, etc.)
      }
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(concurrency, supported.length); k += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

function searchIndex(index, query) {
  if (!index) return [];
  if (!query || query.length < MIN_GLOBAL_QUERY_LEN) return [];
  const results = [];
  for (const entry of index) {
    const count = countSubstringOccurrences(entry.textContent, query);
    if (count > 0) {
      results.push({
        id: entry.id,
        title: entry.title,
        mtime: entry.mtime,
        matchCount: count,
      });
    }
  }
  results.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return (b.mtime || 0) - (a.mtime || 0);
  });
  return results;
}

async function loadGlobalIndex(state, items, fetchFn, extractText, isSupported, onProgress) {
  if (state.globalIndexStatus === 'loading' || state.globalIndexStatus === 'ready') {
    return;
  }
  state.globalIndexStatus = 'loading';
  state.globalIndexProgress = { done: 0, total: 0 };
  const supported = items.filter((it) => isSupported(it));
  state.globalIndexProgress.total = supported.length;
  if (typeof onProgress === 'function') onProgress({ ...state.globalIndexProgress });
  const trackedFetchFn = async (item) => {
    try {
      const body = await fetchFn(item);
      return body;
    } finally {
      state.globalIndexProgress.done += 1;
      if (typeof onProgress === 'function') onProgress({ ...state.globalIndexProgress });
    }
  };
  try {
    const index = await buildGlobalIndex(items, trackedFetchFn, extractText, isSupported);
    state.globalIndex = index;
    state.globalIndexStatus = 'ready';
  } catch (_e) {
    state.globalIndex = null;
    state.globalIndexStatus = 'idle';
  }
  if (typeof onProgress === 'function') onProgress({ ...state.globalIndexProgress });
}

// Uses the search-dom api's `replaceChildren` for parent reset to keep
// the shim-vs-real-DOM path identical to the rest of the module set.
function _replaceChildren(parent, newChildren) {
  if (Array.isArray(parent.children)) {
    parent.children.length = 0;
    for (const c of newChildren) parent.children.push(c);
    return;
  }
  parent.replaceChildren(...newChildren);
}

function renderGlobalResults(container, results, doc, onClick, opts) {
  if (!container) return;
  _replaceChildren(container, []);
  const isFavorite = opts && typeof opts.isFavorite === 'function' ? opts.isFavorite : null;
  for (const r of results) {
    const row = doc.createElement('div');
    row.setAttribute('class', 'sidebar-search-result-row');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    const title = doc.createElement('span');
    title.setAttribute('class', 'sidebar-search-result-title');
    title.appendChild(doc.createTextNode(r.title || r.id));
    row.appendChild(title);
    if (isFavorite && isFavorite(r.id)) {
      const indicator = doc.createElement('span');
      indicator.setAttribute('class', 'favorite-indicator');
      indicator.setAttribute('aria-hidden', 'true');
      indicator.appendChild(doc.createTextNode('★'));
      row.appendChild(indicator);
    }
    const badge = doc.createElement('span');
    badge.setAttribute('class', 'sidebar-search-result-badge');
    badge.appendChild(doc.createTextNode(String(r.matchCount)));
    row.appendChild(badge);
    if (typeof onClick === 'function') {
      if (typeof row.addEventListener === 'function') {
        row.addEventListener('click', () => onClick(r.id, r));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick(r.id, r);
          }
        });
      } else {
        row.__onClick = () => onClick(r.id, r);
      }
    }
    container.appendChild(row);
  }
}

const api = {
  MIN_GLOBAL_QUERY_LEN,
  nextMatchIndex,
  prevMatchIndex,
  countSubstringOccurrences,
  buildGlobalIndex,
  searchIndex,
  loadGlobalIndex,
  renderGlobalResults,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
