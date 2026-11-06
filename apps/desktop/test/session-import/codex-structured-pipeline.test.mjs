import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeFakeDocument, flattenText } = require('../session-viewer/read-fake-document');
const parse = (text) => require('../../lib/codex-conversation').parseCodexConversation(text);

function message(role, text) {
  return { type: 'response_item', payload: { type: 'message', role,
    content: [{ type: 'input_text', text }] } };
}

function read(records) {
  const text = records.map(JSON.stringify).join('\n');
  const { renderStructuredConversation } = require('../../lib/session-viewer/structured-conversation');
  return renderStructuredConversation(parse(text), { document: makeFakeDocument() });
}

test('C1: literal role heading remains inside the original user message', () => {
  const root = read([
    message('user', 'Explain this heading:\n\n## Assistant\n\nStill the user prompt.'),
    message('assistant', 'Actual assistant reply.'),
  ]);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].attrs.class, 'read-section user-turn');
  assert.match(flattenText(root.children[0]), /Still the user prompt/);
  assert.equal(root.children[1].attrs.class, 'read-section assistant-turn');
});

const zero = { malformedRecords: 0, unparsedFinalRecord: 0, unsupportedRecords: 0,
  omittedContentBlocks: 0, excludedRecords: 0 };
const encode = (records) => records.map(JSON.stringify).join('\n');

test('canonical text preserves block order, Unicode, whitespace, and repeated messages', () => {
  const first = message('user', '你好 café 🚀');
  first.payload.content.push({ type: 'output_text', text: '' },
    { type: 'input_text', text: ' second ' });
  const result = parse(encode([first, message('assistant', 'answer'), first]));
  assert.deepEqual(result, {
    messages: [
      { role: 'user', text: '你好 café 🚀\n\n\n\n second ' },
      { role: 'assistant', text: 'answer' },
      { role: 'user', text: '你好 café 🚀\n\n\n\n second ' },
    ], diagnostics: zero,
  });
});

test('known event/tool/metadata records are excluded, never duplicated or used as fallback', () => {
  const excluded = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'same' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'same' } },
    { type: 'session_meta', payload: { id: 'synthetic', cwd: '/synthetic' } },
    { type: 'turn_context', payload: { model: 'synthetic' } },
    { type: 'response_item', payload: { type: 'function_call', arguments: 'excludedneedle' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'excludedneedle' } },
    message('system', 'excludedneedle'), message('developer', 'excludedneedle'),
  ];
  assert.deepEqual(parse(encode(excluded)), { messages: [],
    diagnostics: { ...zero, excludedRecords: 8 } });
  const result = parse(encode([message('user', 'same'), ...excluded, message('assistant', 'same')]));
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.diagnostics, { ...zero, excludedRecords: 8 });
  assert.ok(!JSON.stringify(result).includes('excludedneedle'));
});

test('exact tool headings are text while tool payloads stay excluded from search', () => {
  const records = [message('assistant', '### Tool result\n\nrestoredneedle'),
    { type: 'response_item', payload: { type: 'function_call_output', output: 'excludedneedle' } }];
  const { extractConversationTextRuns } = require('../../lib/session-viewer/read-search-text');
  const { searchIndex } = require('../../lib/session-viewer/search-index');
  const parsed = parse(encode(records));
  const index = [{ id: 'synthetic', textContent: extractConversationTextRuns(parsed) }];
  assert.equal(searchIndex(index, 'restoredneedle')[0].matchCount, 1);
  assert.deepEqual(searchIndex(index, 'excludedneedle'), []);
  assert.match(flattenText(read(records)), /Tool result/);
  assert.equal(parsed.diagnostics.excludedRecords, 1);
});

test('mixed unsupported blocks preserve supported text and do not expose raw attachments', () => {
  const record = message('user', 'keep');
  record.payload.content.push(null, [], 'bad', { type: 'input_text', text: 42 },
    { type: 'input_image', image_url: 'https://example.invalid/private-image' },
    { type: 'output_text', text: 'also keep' });
  assert.deepEqual(parse(encode([record])), {
    messages: [{ role: 'user', text: 'keep\n\nalso keep' }],
    diagnostics: { ...zero, omittedContentBlocks: 5 },
  });
});

test('empty and unsupported-only messages do not fabricate a conversation', () => {
  const empty = message('user', '');
  empty.payload.content.push({ type: 'input_text', text: '' });
  const image = message('user', '');
  image.payload.content = [{ type: 'input_image', image_url: 'synthetic' }];
  assert.deepEqual(parse(encode([empty, image])), {
    messages: [], diagnostics: { ...zero, omittedContentBlocks: 1 },
  });
});

test('invalid record/message shapes and future kinds are diagnosed without throwing', () => {
  const bad = [null, 42, true, 'text', [], {},
    { type: 'future_kind', payload: {} }, { type: 'response_item', payload: [] },
    { type: 'response_item', payload: { type: 'future_item' } },
    message('unknown', 'not a supported role'),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'invalid' } }];
  assert.deepEqual(parse(encode(bad)), { messages: [],
    diagnostics: { ...zero, unsupportedRecords: bad.length } });
});

for (const [name, suffix, expected] of [
  ['valid final without newline', JSON.stringify(message('assistant', 'final')), zero],
  ['invalid final without newline', '{broken', { ...zero, unparsedFinalRecord: 1 }],
  ['invalid terminated record', '{broken\n', { ...zero, malformedRecords: 1 }],
  ['invalid before trailing blank lines', '{broken\n \n', { ...zero, malformedRecords: 1 }],
]) {
  test(`JSONL tail: ${name}`, () => {
    const result = parse(JSON.stringify(message('user', 'first')) + '\r\n' + suffix);
    assert.deepEqual(result.diagnostics, expected);
    assert.deepEqual(result.messages, [{ role: 'user', text: 'first' },
      ...(name.startsWith('valid ') ? [{ role: 'assistant', text: 'final' }] : [])]);
  });
}

test('complete records survive corruption and an unfinished tail recovers on a later parse', () => {
  const answer = JSON.stringify(message('assistant', 'completed'));
  const prefix = '\n \n' + JSON.stringify(message('user', 'before')) + '\n{bad}\n';
  const partial = parse(prefix + answer.slice(0, 25));
  assert.deepEqual(partial.diagnostics, { ...zero, malformedRecords: 1, unparsedFinalRecord: 1 });
  const completed = parse(prefix + answer);
  assert.deepEqual(completed.messages, [{ role: 'user', text: 'before' },
    { role: 'assistant', text: 'completed' }]);
  assert.deepEqual(completed.diagnostics, { ...zero, malformedRecords: 1 });
});

test('parser requires a string, returns independent results, and accepts blank input', () => {
  assert.deepEqual(parse(' \r\n'), { messages: [], diagnostics: zero });
  for (const value of [null, undefined, [], {}]) {
    assert.throws(() => parse(value), { message: 'codex-conversation: text must be a string' });
  }
  const first = parse('');
  first.diagnostics.excludedRecords = 99;
  assert.deepEqual(parse(''), { messages: [], diagnostics: zero });
});

test('C2: a tool-like heading in assistant prose remains visible', () => {
  const root = read([
    message('user', 'Explain tool results.'),
    message('assistant', '### Tool result examples\n\nOrdinary explanation.'),
  ]);
  assert.equal(root.children.length, 2);
  assert.match(flattenText(root.children[1]), /Tool result examples/);
  assert.match(flattenText(root.children[1]), /Ordinary explanation/);
});
