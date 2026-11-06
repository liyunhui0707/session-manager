// Stage S4 — headless controller for the in-file search toolbar.
// Owns wiring of input + prev/next + counter elements (which live in
// index.html as static DOM). The toolbar is shown only while Read mode
// is active.
//
// Active-match scroll-into-view fires on explicit prev/next or global-result
// navigation, never on each keystroke (clarification §7 R-S4-D — avoid
// fighting Stage 6.x scroll-state restoration on input).
//
// IIFE-wrapped + dual CJS/window export.

'use strict';

(function () {

function createInFileSearchToolbar(opts) {
  if (!opts) throw new Error('createInFileSearchToolbar: opts required');
  const {
    toolbarRoot,
    searchInput,
    prevButton,
    nextButton,
    counterEl,
    readMount,
    document: doc,
    searchDom,
    revealMatch,
  } = opts;

  if (!toolbarRoot) throw new Error('createInFileSearchToolbar: toolbarRoot required');
  if (!searchInput) throw new Error('createInFileSearchToolbar: searchInput required');
  if (!prevButton) throw new Error('createInFileSearchToolbar: prevButton required');
  if (!nextButton) throw new Error('createInFileSearchToolbar: nextButton required');
  if (!counterEl) throw new Error('createInFileSearchToolbar: counterEl required');
  if (!readMount) throw new Error('createInFileSearchToolbar: readMount required');
  if (!doc) throw new Error('createInFileSearchToolbar: document required');
  if (!searchDom) throw new Error('createInFileSearchToolbar: searchDom required');

  const state = {
    matches: [],
    currentMatchIndex: 0,
    lastQuery: '',
  };

  function updateCounter() {
    const total = state.matches.length;
    const text = total === 0
      ? '0/0'
      : `${state.currentMatchIndex + 1}/${total}`;
    counterEl.textContent = text;
  }

  function rerunSearch(query) {
    state.lastQuery = query || '';
    searchDom.applyInFileSearch(readMount, query, state, doc);
    updateCounter();
    revealActiveMatch();
  }

  function revealActiveMatch() {
    const match = state.matches[state.currentMatchIndex];
    if (match && typeof revealMatch === 'function') revealMatch(match);
  }

  function scrollActiveIntoView() {
    revealActiveMatch();
    const m = state.matches[state.currentMatchIndex];
    if (m && typeof m.scrollIntoView === 'function') {
      m.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }

  function stepTo(direction) {
    if (state.matches.length === 0) return;
    const oldIdx = state.currentMatchIndex;
    const newIdx = direction === 'next'
      ? (oldIdx + 1) % state.matches.length
      : (oldIdx - 1 + state.matches.length) % state.matches.length;
    state.currentMatchIndex = newIdx;
    searchDom.setActiveMatch(state.matches, oldIdx, newIdx);
    updateCounter();
    scrollActiveIntoView();
  }

  function onInput() {
    rerunSearch(searchInput.value || '');
  }

  function searchAndReveal(query, targetRoot) {
    searchInput.value = query || '';
    rerunSearch(searchInput.value);
    const targetIndex = targetRoot ? state.matches.findIndex(mark => targetRoot.contains(mark)) : -1;
    if (targetIndex >= 0) {
      searchDom.setActiveMatch(state.matches, state.currentMatchIndex, targetIndex);
      state.currentMatchIndex = targetIndex;
      updateCounter();
    }
    scrollActiveIntoView();
    return state.matches.length > 0;
  }

  function onPrev() { stepTo('prev'); }
  function onNext() { stepTo('next'); }

  if (typeof searchInput.addEventListener === 'function') {
    searchInput.addEventListener('input', onInput);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) stepTo('prev'); else stepTo('next');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        searchInput.value = '';
        rerunSearch('');
      }
    });
  }
  if (typeof prevButton.addEventListener === 'function') {
    prevButton.addEventListener('click', onPrev);
  }
  if (typeof nextButton.addEventListener === 'function') {
    nextButton.addEventListener('click', onNext);
  }

  function onReadActivated() {
    toolbarRoot.hidden = false;
    // Stale state from a previous Read render must not leak (the marks
    // in `state.matches` may reference DOM nodes that no longer exist
    // because the Read renderer rebuilt readMount).
    state.matches = [];
    state.currentMatchIndex = 0;
    state.lastQuery = '';
    searchInput.value = '';
    updateCounter();
  }

  function onReadDeactivated() {
    toolbarRoot.hidden = true;
    if (state.lastQuery) {
      searchDom.clearHighlights(readMount, doc);
    }
    state.matches = [];
    state.currentMatchIndex = 0;
    state.lastQuery = '';
    searchInput.value = '';
    updateCounter();
  }

  function refreshAfterRender() {
    // Caller (the Read rendering pipeline) signals that readMount was
    // just rebuilt. Old `state.matches` still hold references to old
    // <mark> nodes; if the user had a query active, re-run it against
    // the new DOM.
    state.matches = [];
    state.currentMatchIndex = 0;
    if (state.lastQuery) {
      rerunSearch(state.lastQuery);
    } else {
      updateCounter();
    }
  }

  // Initial counter paint.
  updateCounter();

  return {
    onReadActivated,
    onReadDeactivated,
    refreshAfterRender,
    searchAndReveal,
    getMatches() { return state.matches.slice(); },
    getCurrentMatchIndex() { return state.currentMatchIndex; },
    getLastQuery() { return state.lastQuery; },
  };
}

const api = { createInFileSearchToolbar };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
