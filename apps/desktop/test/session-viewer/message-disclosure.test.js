'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderStructuredConversation } = require('../../lib/session-viewer/structured-conversation');
const { makeFakeDocument, findAllByTag, flattenText } = require('./read-fake-document');
const SearchDom = require('../../lib/session-viewer/search-dom');
const { extractConversationTextRuns } = require('../../lib/session-viewer/read-search-text');
const { searchIndex } = require('../../lib/session-viewer/search-index');
function render(texts, collapseLongMessages = true) {
  const doc = makeFakeDocument();
  const create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag), listeners = {};
    el.addEventListener = (event, fn) => { listeners[event] = fn; };
    el.click = () => listeners.click();
    return el;
  };
  const conversation = { messages: texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text })) };
  const root = doc.createElement('article');
  root.appendChild(renderStructuredConversation(conversation, { document: doc, collapseLongMessages }));
  return { root, doc, conversation };
}
function body(section) { return section.children.find(n => n.getAttribute && n.getAttribute('class') === 'message-full-body'); }

test('long assistant replies start expanded and can collapse while long prompts start folded', () => {
  const h = render(['## Assistant\n\n' + 'Long question '.repeat(70) + 'tail question', 'Long answer '.repeat(90) + 'tail answer']);
  assert.equal(h.root.children.length, 2);
  for (const [i, section] of h.root.children.entries()) {
    const button = findAllByTag(section, 'button')[0];
    assert.ok(button, 'long message has a disclosure control');
    assert.equal(button.textContent, i ? '收起正文' : '展开全文');
    assert.equal(button.getAttribute('aria-expanded'), i ? 'true' : 'false');
    assert.equal(body(section).hidden, !i);
    assert.equal(button.getAttribute('aria-controls'), body(section).getAttribute('id'));
    button.click();
    assert.equal(body(section).hidden, !!i);
    assert.equal(button.textContent, i ? '展开全文' : '收起正文');
    assert.equal(button.getAttribute('aria-expanded'), i ? 'false' : 'true');
    assert.match(flattenText(body(section)), i ? /tail answer/ : /tail question/);
    button.click();
    assert.equal(body(section).hidden, !i);
    assert.equal(flattenText(section.children[0]), i ? '助手' : '你');
  }
  assert.notEqual(body(h.root.children[0]).getAttribute('id'), body(h.root.children[1]).getAttribute('id'));
  assert.equal(h.doc.unsafeApiWrites, 0);
});

test('thresholds depend only on length/lines; the default structured renderer remains unchanged', () => {
  for (const [text, folded] of [['x'.repeat(799), false], ['x'.repeat(800), true], [Array(11).fill('line').join('\n'), false], [Array(12).fill('line').join('\n'), true], ['# AGENTS.md instructions\n\nshort question', false]]) {
    assert.equal(findAllByTag(render([text]).root, 'button').length, folded ? 1 : 0);
  }
  assert.equal(findAllByTag(render(['x'.repeat(900)], false).root, 'button').length, 0);
});

test('previews are bounded plain text; Unicode and hostile markup remain intact in full content', () => {
  const h = render(['<script>unsafe()</script>\n\n' + '你🙂'.repeat(400)]);
  const preview = h.root.children[0].children.find(n => n.getAttribute && n.getAttribute('class') === 'message-preview');
  assert.ok(preview);
  assert.ok(preview.textContent.length <= 241);
  assert.doesNotMatch(preview.textContent, /[\uD800-\uDBFF]…$/);
  assert.equal(findAllByTag(h.root, 'script').length, 0);
  assert.match(flattenText(body(h.root.children[0])), /你🙂/);
  assert.equal(h.doc.unsafeApiWrites, 0);
});

test('search includes collapsed bodies once, excludes previews/controls and preserves counts across toggles', () => {
  const h = render(['needle ' + 'padding '.repeat(110) + 'tailneedle', 'needle']);
  const button = findAllByTag(h.root, 'button')[0];
  assert.ok(button);
  const expected = searchIndex([{ id: 'fixture', textContent: extractConversationTextRuns(h.conversation) }], 'needle')[0].matchCount;
  assert.equal(expected, 3);
  for (let i = 0; i < 3; i++) {
    const state = {};
    SearchDom.applyInFileSearch(h.root, 'needle', state, h.doc);
    assert.equal(state.matches.length, expected);
    for (const query of ['展开全文', '收起正文', 'Show full message', 'Collapse']) {
      SearchDom.applyInFileSearch(h.root, query, state, h.doc);
      assert.equal(state.matches.length, 0);
    }
    assert.ok(['展开全文', '收起正文'].includes(button.textContent));
    button.click();
  }
});

test('revealing a match expands only its enclosing message', () => {
  const h = render(['first '.repeat(180), 'second '.repeat(180)]);
  const { revealMessageMatch } = require('../../lib/session-viewer/message-disclosure');
  const button = findAllByTag(h.root.children[1], 'button')[0];
  button.click(); // Explicitly fold the initially expanded assistant reply.
  assert.equal(body(h.root.children[1]).hidden, true);
  revealMessageMatch(body(h.root.children[1]).children[0]);
  assert.equal(body(h.root.children[0]).hidden, true);
  assert.equal(body(h.root.children[1]).hidden, false);
  revealMessageMatch(null);
  revealMessageMatch(h.doc.createElement('mark'));
});

test('disclosure labels quoted in real message content remain searchable exactly once', () => {
  const h = render(['展开全文、收起正文、Show full message and Collapse are literal text. ' + 'padding '.repeat(110)]);
  for (const query of ['展开全文', '收起正文', 'Show full message', 'Collapse']) {
    const state = {};
    SearchDom.applyInFileSearch(h.root, query, state, h.doc);
    assert.equal(state.matches.length, 1);
  }
});
