'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDocument, flattenText } = require('./read-fake-document');
const { renderMarkdown } = require('../../lib/session-viewer/read-renderer');
const { searchIndex } = require('../../lib/session-viewer/search-index');
const { applyInFileSearch } = require('../../lib/session-viewer/search-dom');
const render = (conversation, document = makeFakeDocument()) =>
  require('../../lib/session-viewer/structured-conversation')
    .renderStructuredConversation(conversation, { document });
const extract = (conversation) => require('../../lib/session-viewer/read-search-text')
  .extractConversationTextRuns(conversation);
const conversation = (...texts) => ({ messages: texts.map((text, i) =>
  ({ role: i % 2 ? 'assistant' : 'user', text })) });

test('all body headings stay inside their data-defined role', () => {
  const input = conversation('# Heading\n\n## Assistant — 2026-01-01\n\ntext\n\n## User\n\n### Tool use\n\n### Tool result',
    '## User — fake\n\nReal assistant text');
  const root = render(input);
  assert.equal(root.children.length, 2);
  for (const [i, section] of root.children.entries()) {
    assert.equal(section.attrs.class, `read-section ${input.messages[i].role}-turn`);
    assert.ok(section.children.every((child) => child.tag !== 'section'));
  }
  assert.match(flattenText(root.children[0]), /Tool useTool result/);
  assert.match(flattenText(root.children[1]), /Real assistant text/);
});

test('unterminated fence and user-wrapper state cannot consume a subsequent message', () => {
  const root = render(conversation('```text\n## Assistant\nliteral',
    'next answer', '<system-reminder>\nuser text', 'last answer'));
  assert.equal(root.children.length, 4);
  assert.match(flattenText(root.children[0]), /## Assistant\nliteral/);
  assert.equal(flattenText(root.children[1]), '助手next answer');
  assert.match(flattenText(root.children[2]), /<system-reminder>\nuser text/);
  assert.equal(flattenText(root.children[3]), '助手last answer');
});

test('structured text keeps literal legacy wrappers and skill prefixes; legacy still filters them', () => {
  const body = '<system-reminder>literal text</system-reminder>\n\n' +
    '<command-name>/sample</command-name>\n<command-args>args</command-args>\n\n' +
    'Base directory for this skill: synthetic\nkeep the explanation';
  const root = render(conversation(body));
  const text = flattenText(root);
  for (const expected of ['literal text', '<command-name>', '<command-args>', 'keep the explanation']) {
    assert.ok(text.includes(expected));
  }
  const legacy = renderMarkdown('## User\n' + body, { document: makeFakeDocument() });
  assert.ok(!flattenText(legacy).includes('literal text'));
  assert.ok(!flattenText(legacy).includes('keep the explanation'));
});

test('ordinary supported Markdown shares the legacy body rendering', () => {
  const body = '# Heading\n\n## Topic\n\n### Detail\n\nleft**bold** _italic_ `code`\n\n' +
    '- parent\n  - child\n    continued\n\n| first | second |\n| --- | --- |\n| value | value |\n\n```\ncode\n```';
  const legacy = renderMarkdown('## User\n' + body, { document: makeFakeDocument() });
  const structured = render(conversation(body));
  const tree = (node) => node.nodeType === 3 ? node.textContent :
    { tag: node.tag, attrs: node.attrs, children: (node.children || []).map(tree) };
  // Role labels are localized; Markdown body structure remains identical.
  const a = tree(structured), b = tree(legacy);
  b.children[0].children[0].children = ['你'];
  assert.deepEqual(a, b);
});

test('structured rendering never creates active HTML and leaves input unchanged', () => {
  const input = conversation('<script>unsafe()</script>\n\n<img src="https://example.invalid/pixel">\n\n' +
    '[link](javascript:unsafe()) ![image](https://example.invalid/image)');
  Object.freeze(input.messages[0]); Object.freeze(input.messages); Object.freeze(input);
  const doc = makeFakeDocument();
  const root = render(input, doc);
  const tags = [];
  function collect(node) {
    if (node.tag) tags.push(node.tag);
    for (const child of node.children || []) collect(child);
  }
  collect(root);
  assert.ok(!tags.some((tag) => ['script', 'img', 'a', 'iframe'].includes(tag)));
  assert.equal(doc.unsafeApiWrites, 0);
  assert.match(flattenText(root), /unsafe\(\)/);
});

test('invalid conversation or message shape rejects before allocating DOM', () => {
  const doc = { createDocumentFragment() { assert.fail('allocated DOM for invalid input'); } };
  const bad = [null, [], {}, { messages: {} }, { messages: [null] }, { messages: new Array(1) },
    { messages: [{ role: 'system', text: 'bad' }] }, { messages: [{ role: 'user', text: 42 }] },
    { messages: [{ role: 'user', text: 'valid first' }, { role: '<script>', text: 'bad' }] }];
  for (const input of bad) {
    assert.throws(() => render(input, doc), { message: 'structured-conversation: invalid messages' });
  }
  assert.equal(render({ messages: [] }).children.length, 0);
  assert.equal(render(conversation('')).children.length, 1);
});

test('browser exports preserve legacy loading without the optional structured script', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const context = vm.createContext({ window: {} });
  function load(name) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../lib/session-viewer', name), 'utf8'), context);
  }
  for (const name of ['read-inline.js', 'read-user-preprocess.js', 'read-renderer.js', 'read-search-text.js']) load(name);
  assert.ok(context.window.SessionViewer.extractReadTextRuns('## User\nlegacy').includes('legacy'));
  assert.equal(context.window.SessionViewer.renderStructuredConversation, undefined);
  load('conversation-presentation.js');
  load('structured-conversation.js');
  const input = conversation('## Assistant\n\nstill user', '### Tool result\n\nstill visible');
  const root = context.window.SessionViewer.renderStructuredConversation(input, { document: makeFakeDocument() });
  assert.equal(root.children.length, 2);
  assert.match(flattenText(root.children[0]), /still user/);
  assert.ok(context.window.SessionViewer.extractConversationTextRuns(input).includes('still visible'));
});

for (const [label, input, queries] of [
  ['headings', conversation('## Assistant\n\n你好', '### Tool result\n\nrestoredneedle'), ['你好', 'restoredneedle', 'Assistant']],
  ['formatting', conversation('left**right** and `code`', 'end'), ['leftright', 'right', 'code']],
  ['boundaries', conversation('alpha', 'beta'), ['alphabeta', 'alpha', 'beta']],
  ['tables and lists', conversation('| first | second |\n| --- | --- |\n| value | value |\n\n- parent\n  - nested\n    continued'), ['firstsecond', 'value', 'nested continued']],
]) {
  test(`structured search counts match reader highlights: ${label}`, () => {
    const runs = extract(input);
    for (const query of queries) {
      const doc = makeFakeDocument();
      const mount = doc.createElement('article');
      mount.appendChild(render(input, doc));
      const state = {};
      applyInFileSearch(mount, query, state, doc);
      assert.equal(searchIndex([{ id: 'synthetic', textContent: runs }], query)[0]?.matchCount || 0,
        state.matches.length, query);
    }
    if (label === 'boundaries') assert.deepEqual(searchIndex([{ id: 's', textContent: runs }], 'alphabeta'), []);
  });
}

test('large structured indexing never accesses the browser document or diagnostics text', () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true,
    get() { assert.fail('accessed browser document while indexing'); } });
  try {
    const input = conversation('synthetic '.repeat(57000) + 'tailneedle');
    input.diagnostics = { message: 'diagnosticneedle' };
    const index = [{ id: 's', textContent: extract(input) }];
    assert.equal(searchIndex(index, 'tailneedle')[0].matchCount, 1);
    assert.deepEqual(searchIndex(index, 'diagnosticneedle'), []);
  } finally {
    if (old) Object.defineProperty(globalThis, 'document', old);
    else delete globalThis.document;
  }
});

test('continued long-message code stays code, with safe markup and an ignored part label', () => {
  const input = { messages: [{ role: 'assistant', text: '<script>literal</script>\n```\n\n**Done**',
    continuation: { number: 2, total: 3, fenceMarker: 3, startsMidLine: false } }] };
  const root = render(input);
  const section = root.children[0];
  assert.ok(section.children.some(node => node.tag === 'pre'));
  assert.ok(flattenText(root).includes('<script>literal</script>'));
  assert.ok(flattenText(root).includes('Done'));
  assert.ok(!extract(input).some(text => text.includes('长消息')));
  assert.ok(extract(input).includes('<script>literal</script>'));
});
test('a code-line continuation starting with backticks does not close the original fence', () => {
  const input = { messages: [{ role: 'assistant', text: '```\nstill literal\n```\n\n**Done**',
    continuation: { number: 2, total: 2, fenceMarker: 3, startsMidLine: true } }] };
  const root = render(input);
  const code = root.children[0].children.find(node => node.tag === 'pre').children[0];
  assert.equal(flattenText(code), '```\nstill literal');
});
