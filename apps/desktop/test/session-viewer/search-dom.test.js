/* Stage S4 — unit tests for search-dom.js
   Run: node --test test/session-viewer/search-dom.test.js  */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const SearchDom = require('../../lib/session-viewer/search-dom');
const { makeFakeDocument, flattenText, findAllByTag } = require('./read-fake-document');

function tree(doc, spec) {
  // Build a small fake tree. `spec` is { tag, children: [...] } where a
  // child string becomes a text node.
  if (typeof spec === 'string') return doc.createTextNode(spec);
  const el = doc.createElement(spec.tag);
  for (const c of spec.children || []) el.appendChild(tree(doc, c));
  return el;
}

// ---------- wrapMatchesInTextNode ----------

test('T-S4-1 wrapMatchesInTextNode returns node unchanged when query empty', () => {
  const doc = makeFakeDocument();
  const tn = doc.createTextNode('hello world');
  const out = SearchDom.wrapMatchesInTextNode(tn, '', doc);
  assert.equal(out.length, 1);
  assert.equal(out[0], tn);
});

test('T-S4-2 wrapMatchesInTextNode wraps single match', () => {
  const doc = makeFakeDocument();
  const tn = doc.createTextNode('hello world');
  const out = SearchDom.wrapMatchesInTextNode(tn, 'world', doc);
  assert.equal(out.length, 2);
  assert.equal(out[0].nodeType, 3);
  assert.equal(out[0].textContent, 'hello ');
  assert.equal(out[1].tag, 'mark');
  assert.equal(out[1].children[0].textContent, 'world');
});

test('T-S4-3 wrapMatchesInTextNode wraps multiple matches', () => {
  const doc = makeFakeDocument();
  const tn = doc.createTextNode('aaXbbXcc');
  const out = SearchDom.wrapMatchesInTextNode(tn, 'X', doc);
  // Expected: ["aa", <mark>X</mark>, "bb", <mark>X</mark>, "cc"]
  assert.equal(out.length, 5);
  assert.equal(out[1].tag, 'mark');
  assert.equal(out[3].tag, 'mark');
});

test('T-S4-4 wrapMatchesInTextNode is case-insensitive', () => {
  const doc = makeFakeDocument();
  const tn = doc.createTextNode('Hello WORLD');
  const out = SearchDom.wrapMatchesInTextNode(tn, 'world', doc);
  assert.equal(out.length, 2);
  assert.equal(out[1].tag, 'mark');
  assert.equal(out[1].children[0].textContent, 'WORLD');
});

test('T-S4-5 wrapMatchesInTextNode handles special chars literally', () => {
  const doc = makeFakeDocument();
  const tn = doc.createTextNode('use .* as a literal pattern here');
  const out = SearchDom.wrapMatchesInTextNode(tn, '.*', doc);
  // Should match the literal ".*" (substring), not as regex meta.
  assert.equal(out.length, 3);
  assert.equal(out[1].tag, 'mark');
  assert.equal(out[1].children[0].textContent, '.*');
});

// ---------- walkAndHighlight ----------

test('T-S4-6 walkAndHighlight wraps marks across nested elements', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, {
    tag: 'div',
    children: [
      'hello ',
      { tag: 'strong', children: ['brave '] },
      'new world',
    ],
  });
  const marks = SearchDom.walkAndHighlight(root, 'e', doc);
  // 'hello' has 1 'e', 'brave' has 1 'e', 'new' has 1 'e' → 3 marks.
  assert.equal(marks.length, 3);
  assert.equal(doc.unsafeApiWrites, 0);
});

test('T-S4-7 walkAndHighlight preserves existing marks (no re-wrap)', () => {
  const doc = makeFakeDocument();
  const existingMark = doc.createElement('mark');
  existingMark.appendChild(doc.createTextNode('foo'));
  const root = doc.createElement('div');
  root.appendChild(existingMark);
  root.appendChild(doc.createTextNode(' foo bar'));
  const marks = SearchDom.walkAndHighlight(root, 'foo', doc);
  // 1 existing + 1 new = 2 marks total kept around.
  assert.equal(marks.length, 1);
  // The existing mark should still be the first child.
  assert.equal(root.children[0], existingMark);
});

test('T-S4-8 walkAndHighlight returns empty array on empty query', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, { tag: 'div', children: ['hello world'] });
  const marks = SearchDom.walkAndHighlight(root, '', doc);
  assert.deepEqual(marks, []);
});

test('T-S4-9 walkAndHighlight returns empty on null root', () => {
  const doc = makeFakeDocument();
  const marks = SearchDom.walkAndHighlight(null, 'x', doc);
  assert.deepEqual(marks, []);
});

// ---------- clearHighlights ----------

test('T-S4-10 clearHighlights removes marks + restores text', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, { tag: 'div', children: ['hello world'] });
  SearchDom.walkAndHighlight(root, 'world', doc);
  assert.equal(findAllByTag(root, 'mark').length, 1);
  SearchDom.clearHighlights(root, doc);
  assert.equal(findAllByTag(root, 'mark').length, 0);
  assert.equal(flattenText(root), 'hello world');
});

test('T-S4-11 clearHighlights coalesces sibling text after mark removal', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, { tag: 'div', children: ['aaXbbXcc'] });
  SearchDom.walkAndHighlight(root, 'X', doc);
  SearchDom.clearHighlights(root, doc);
  // After clear+coalesce: a single text node "aaXbbXcc".
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].nodeType, 3);
  assert.equal(root.children[0].textContent, 'aaXbbXcc');
});

test('T-S4-12 clearHighlights is idempotent on a mark-free tree', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, {
    tag: 'div',
    children: ['hello ', { tag: 'strong', children: ['world'] }],
  });
  SearchDom.clearHighlights(root, doc);
  assert.equal(flattenText(root), 'hello world');
});

// ---------- applyInFileSearch ----------

test('T-S4-13 applyInFileSearch on null container is a no-op + resets state', () => {
  const doc = makeFakeDocument();
  const state = { matches: ['stale'], currentMatchIndex: 7 };
  SearchDom.applyInFileSearch(null, 'x', state, doc);
  assert.deepEqual(state.matches, []);
  assert.equal(state.currentMatchIndex, 0);
});

test('T-S4-14 applyInFileSearch with empty query clears state', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, { tag: 'div', children: ['hello world'] });
  SearchDom.walkAndHighlight(root, 'world', doc);
  const state = { matches: [], currentMatchIndex: 0 };
  SearchDom.applyInFileSearch(root, '', state, doc);
  assert.deepEqual(state.matches, []);
  assert.equal(state.currentMatchIndex, 0);
  assert.equal(findAllByTag(root, 'mark').length, 0);
});

test('T-S4-15 applyInFileSearch sets active class on first match', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, { tag: 'div', children: ['hello world hello'] });
  const state = { matches: [], currentMatchIndex: 0 };
  SearchDom.applyInFileSearch(root, 'hello', state, doc);
  assert.equal(state.matches.length, 2);
  assert.equal(state.matches[0].attrs.class, 'mark mark--active');
  assert.equal(state.matches[1].attrs.class, undefined); // not set yet
});

test('T-S4-15a search-dom never writes innerHTML / outerHTML / insertAdjacentHTML', () => {
  const doc = makeFakeDocument();
  const root = tree(doc, {
    tag: 'div',
    children: ['mix ', { tag: 'strong', children: ['mix mix'] }, ' mix'],
  });
  const state = { matches: [], currentMatchIndex: 0 };
  SearchDom.applyInFileSearch(root, 'mix', state, doc);
  SearchDom.applyInFileSearch(root, '', state, doc);
  SearchDom.applyInFileSearch(root, 'mix', state, doc);
  assert.equal(doc.unsafeApiWrites, 0);
});

// ---------- setActiveMatch ----------

test('T-S4-15b setActiveMatch flips classes between old and new', () => {
  const doc = makeFakeDocument();
  const m1 = doc.createElement('mark');
  const m2 = doc.createElement('mark');
  const matches = [m1, m2];
  matches[0].setAttribute('class', 'mark mark--active');
  SearchDom.setActiveMatch(matches, 0, 1);
  assert.equal(m1.attrs.class, 'mark');
  assert.equal(m2.attrs.class, 'mark mark--active');
});

test('T-S4-15c setActiveMatch tolerates empty list', () => {
  // Must not throw.
  SearchDom.setActiveMatch([], 0, 0);
  SearchDom.setActiveMatch(null, 0, 0);
});

// ---------- source-shape (kept for round-1 m1 / SC carry-over) ----------

test('search-dom.js is IIFE-wrapped + dual-export', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'session-viewer', 'search-dom.js'),
    'utf8',
  );
  assert.match(src, /\(function \(\) \{/);
  assert.match(src, /\}\)\(\);/);
  assert.match(src, /module\.exports\s*=\s*api/);
  assert.match(src, /window\.SessionViewer\s*=\s*Object\.assign\(window\.SessionViewer/);
});
