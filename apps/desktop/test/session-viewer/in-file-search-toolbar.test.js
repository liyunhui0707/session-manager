/* Stage S4 — headless tests for the in-file search toolbar controller.
   Run: node --test test/session-viewer/in-file-search-toolbar.test.js  */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SearchDom = require('../../lib/session-viewer/search-dom');
const { createInFileSearchToolbar } = require('../../lib/session-viewer/in-file-search-toolbar');
const { makeFakeDocument, findAllByTag } = require('./read-fake-document');

function makeEventy() {
  // Augment fake elements with addEventListener so the controller can
  // attach input / click / keydown handlers; tests fire them via .fire().
  const handlers = {};
  return {
    addEventListener(name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
    },
    fire(name, e) {
      (handlers[name] || []).forEach((fn) => fn(e || {}));
    },
  };
}

function makeHarness() {
  const doc = makeFakeDocument();

  const toolbarRoot = doc.createElement('div');
  toolbarRoot.hidden = true;

  const searchInput = Object.assign(doc.createElement('input'), { value: '' });
  Object.assign(searchInput, makeEventy());

  const prevButton = doc.createElement('button');
  Object.assign(prevButton, makeEventy());

  const nextButton = doc.createElement('button');
  Object.assign(nextButton, makeEventy());

  const counterEl = doc.createElement('span');
  counterEl.textContent = '';

  const readMount = doc.createElement('div');
  // Seed read DOM with text the test can search against.
  readMount.appendChild(doc.createTextNode('hello world hello again'));

  const controller = createInFileSearchToolbar({
    toolbarRoot, searchInput, prevButton, nextButton, counterEl,
    readMount, document: doc, searchDom: SearchDom,
  });

  return { doc, toolbarRoot, searchInput, prevButton, nextButton, counterEl, readMount, controller };
}

// ---------- T-S4-30..34 ----------

test('T-S4-30 controller is initially hidden + counter shows 0/0', () => {
  const h = makeHarness();
  assert.equal(h.toolbarRoot.hidden, true);
  assert.equal(h.counterEl.textContent, '0/0');
});

test('T-S4-31 onReadActivated shows toolbar + resets state', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  assert.equal(h.toolbarRoot.hidden, false);
  assert.equal(h.searchInput.value, '');
  assert.equal(h.counterEl.textContent, '0/0');
  assert.deepEqual(h.controller.getMatches(), []);
});

test('T-S4-32 input event triggers walkAndHighlight + updates counter', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.searchInput.value = 'hello';
  h.searchInput.fire('input');
  assert.equal(h.controller.getMatches().length, 2);
  assert.equal(h.counterEl.textContent, '1/2');
  // First match is active
  assert.equal(h.controller.getMatches()[0].attrs.class, 'mark mark--active');
});

test('T-S4-33a next button cycles match index forward', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.searchInput.value = 'hello';
  h.searchInput.fire('input');
  h.nextButton.fire('click');
  assert.equal(h.controller.getCurrentMatchIndex(), 1);
  assert.equal(h.counterEl.textContent, '2/2');
  // Active class moved
  const matches = h.controller.getMatches();
  assert.equal(matches[0].attrs.class, 'mark');
  assert.equal(matches[1].attrs.class, 'mark mark--active');
});

test('T-S4-33b prev button wraps from 0 to last', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.searchInput.value = 'hello';
  h.searchInput.fire('input');
  h.prevButton.fire('click');
  assert.equal(h.controller.getCurrentMatchIndex(), 1);
});

test('T-S4-33c Enter in input = next; Shift+Enter = prev', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.searchInput.value = 'hello';
  h.searchInput.fire('input');
  h.searchInput.fire('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(h.controller.getCurrentMatchIndex(), 1);
  h.searchInput.fire('keydown', { key: 'Enter', shiftKey: true, preventDefault() {} });
  assert.equal(h.controller.getCurrentMatchIndex(), 0);
});

test('T-S4-33d Escape clears the input + matches', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.searchInput.value = 'hello';
  h.searchInput.fire('input');
  h.searchInput.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(h.searchInput.value, '');
  assert.equal(h.controller.getMatches().length, 0);
  assert.equal(h.counterEl.textContent, '0/0');
});

test('T-S4-34 onReadDeactivated hides toolbar + clears highlights', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.searchInput.value = 'hello';
  h.searchInput.fire('input');
  assert.equal(findAllByTag(h.readMount, 'mark').length, 2);
  h.controller.onReadDeactivated();
  assert.equal(h.toolbarRoot.hidden, true);
  assert.equal(findAllByTag(h.readMount, 'mark').length, 0);
  assert.equal(h.searchInput.value, '');
  assert.equal(h.counterEl.textContent, '0/0');
});

test('T-S4-34a refreshAfterRender re-runs the active query on the new DOM', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.searchInput.value = 'hello';
  h.searchInput.fire('input');
  // Simulate Read renderer rebuilding the DOM.
  h.readMount.children.length = 0;
  h.readMount.appendChild(h.doc.createTextNode('hello brand new world'));
  h.controller.refreshAfterRender();
  // Re-runs on new DOM → 1 match for 'hello'.
  assert.equal(h.controller.getMatches().length, 1);
  assert.equal(h.counterEl.textContent, '1/1');
});

test('T-S4-34b refreshAfterRender with empty query just updates counter', () => {
  const h = makeHarness();
  h.controller.onReadActivated();
  h.controller.refreshAfterRender();
  assert.equal(h.counterEl.textContent, '0/0');
});

test('T-S4-34c controller throws on missing required opts', () => {
  assert.throws(() => createInFileSearchToolbar({}));
});

test('reveals the active match before scrolling; typing reveals without forcing scroll', () => {
  const doc = makeFakeDocument(), events = [];
  const marks = [0, 1].map(i => ({ scrollIntoView() { events.push('scroll ' + i); } }));
  const el = () => Object.assign(doc.createElement('div'), makeEventy(), { value: '' });
  const searchInput = el(), prevButton = el(), nextButton = el(), counterEl = el();
  const controller = createInFileSearchToolbar({
    toolbarRoot: el(), searchInput, prevButton, nextButton, counterEl, readMount: el(), document: doc,
    revealMatch: mark => events.push('reveal ' + marks.indexOf(mark)),
    searchDom: {
      applyInFileSearch(_mount, query, state) { state.matches = query ? marks : []; state.currentMatchIndex = 0; },
      setActiveMatch() {}, clearHighlights() {},
    },
  });
  controller.onReadActivated();
  searchInput.value = 'needle'; searchInput.fire('input');
  assert.deepEqual(events, ['reveal 0']);
  nextButton.fire('click');
  assert.deepEqual(events.slice(-2), ['reveal 1', 'scroll 1']);
  prevButton.fire('click');
  assert.deepEqual(events.slice(-2), ['reveal 0', 'scroll 0']);
  searchInput.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(counterEl.textContent, '0/0');
  const before = events.length;
  nextButton.fire('click'); assert.equal(events.length, before);
  controller.searchAndReveal('needle');
  assert.deepEqual(events.slice(-2), ['reveal 0', 'scroll 0']);
  assert.equal(controller.searchAndReveal('needle', { contains: mark => mark === marks[1] }), true);
  assert.deepEqual(events.slice(-2), ['reveal 1', 'scroll 1']);
  assert.equal(counterEl.textContent, '2/2');
  assert.equal(controller.searchAndReveal('', { contains: () => false }), false);
});
