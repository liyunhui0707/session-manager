'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zstdCompressSync } = require('node:zlib');
const { createConversationReader } = require('../../lib/codex-page-reader-v2');
const record = payload => JSON.stringify({ type: 'event_msg', payload }) + '\n';
const message = (role, content) => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role, phase: role === 'assistant' ? 'final_answer' : undefined, content,
} }) + '\n';
const hash = text => createHash('sha256').update(text).digest('hex');
async function setup(t, text, compressed) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-large-text-')));
  const filePath = path.join(root, 'rollout-invented.jsonl' + (compressed ? '.zst' : ''));
  await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  const reader = createConversationReader();
  t.after(async () => { await reader.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { reader, filePath, source: { filePath, canonicalRoot: root, name: 'Invented long text' } };
}

for (const compressed of [false, true]) test(`16 MiB prompt and final remain searchable in the 96 MiB worker (${compressed ? 'zstd' : 'raw'})`, async t => {
  const text = 'BEGIN-LARGE\n' + 'x'.repeat(8 * 1024 ** 2) + '\nMIDDLE-LARGE\n' + 'y'.repeat(8 * 1024 ** 2) + '\nEND-LARGE';
  const { reader, source, filePath } = await setup(t,
    record({ type: 'user_message', message: text }) + record({ type: 'task_complete', last_agent_message: text }), compressed);
  const before = hash(await fs.readFile(filePath));
  const latest = await reader.open(source);
  assert.equal(latest.conversation.diagnostics.oversizedMessages, 0);
  assert.ok(latest.conversation.messages.at(-1).text.endsWith('END-LARGE'));
  assert.ok(Buffer.byteLength(JSON.stringify(latest)) < 1024 ** 2, 'IPC must contain only the selected part');
  for (const query of ['BEGIN-LARGE', 'MIDDLE-LARGE', 'END-LARGE']) {
    const found = await reader.search(source, query);
    assert.equal(found.count, 2);
    assert.equal(found.incomplete, false);
    assert.equal(found.matches.length, 2);
    for (const hit of found.matches) {
      const result = await reader.open(source, { page: hit.page });
      assert.ok(result.conversation.messages[hit.message].text.includes(query));
    }
  }
  assert.equal(hash(await fs.readFile(filePath)), before);
});

test('large multi-block text deduplicates its event mirror and reconstructs every UTF-16 unit', async t => {
  const first = '```text\n' + '🙂中 line\n'.repeat(90000);
  const second = 'more\n'.repeat(280000) + '```\nFINISH';
  const text = first + '\n\n' + second;
  const blocks = [{ text: first, type: 'input_text' }, { text: 'excluded tool', type: 'tool_result' }, { type: 'input_text', text: second }];
  const { reader, source } = await setup(t, message('user', blocks) + record({ type: 'user_message', message: text }) +
    message('assistant', blocks.map(b => ({ ...b, type: b.type === 'input_text' ? 'output_text' : b.type }))) +
    record({ type: 'task_complete', last_agent_message: text }), true);
  const search = await reader.search(source, 'FINISH');
  assert.equal(search.count, 2, 'mirrored prompt/final must each appear only once');
  assert.equal(search.incomplete, false);
  const pieces = { user: [], assistant: [] };
  let current = await reader.open(source, { page: 0 });
  for (;;) {
    for (const item of current.conversation.messages) {
      pieces[item.role].push(item.text);
      assert.ok(Buffer.byteLength(item.text) <= 512 * 1024);
    }
    if (!current.page.hasNext) break;
    current = await reader.move(current.page.readerId, 'next');
  }
  assert.equal(pieces.user.join(''), text);
  assert.equal(pieces.assistant.join(''), text);
});

test('cross-part search, expanding case folds and an emoji on the cut choose the right page', async t => {
  const stride = 128 * 1024;
  const text = 'İ'.repeat(stride - 4) + 'BOUNDARY-NEEDLE' + 'x'.repeat(stride - 12) + '🙂EMOJI' +
    'x'.repeat(3 * 1024 ** 2) + 'ΟΣ A';
  assert.equal(text.indexOf('🙂'), stride * 2 - 1);
  const { reader, source } = await setup(t, record({ type: 'task_complete', last_agent_message: text }), false);
  const found = await reader.search(source, 'boundary-needle');
  assert.equal(found.matches.length, 1);
  assert.ok(found.matches[0].snippet.includes('BOUNDARY-NEEDLE'));
  const page = await reader.open(source, { page: found.matches[0].page });
  const next = await reader.move(page.page.readerId, 'next');
  assert.ok((page.conversation.messages.at(-1).text + next.conversation.messages[0].text).includes('BOUNDARY-NEEDLE'));
  const emoji = await reader.search(source, '🙂EMOJI');
  const selected = await reader.open(source, { page: emoji.matches[0].page });
  assert.ok(selected.conversation.messages[emoji.matches[0].message].text.startsWith('🙂EMOJI'));
  assert.equal((await reader.search(source, 'οσ a')).matches.length, 1);
  assert.equal((await reader.search(source, 'ος a')).matches.length, 1);
});

test('late discriminators and duplicate JSON keys do not leak obsolete text or corrupt the joined hash', async t => {
  const text = 'a'.repeat(3 * 1024 ** 2) + '\n\nJOINED-TAIL';
  const json = '{"payload":{"role":"user","content":[' +
    '{"text":"obsolete","text":' + JSON.stringify(text.slice(0, -13)) + ',"type":"input_text"},' +
    '{"text":"hidden-secret-marker","type":"input_text","type":"tool_result"},' +
    '{"type":"input_text","text":"JOINED-TAIL"}],"type":"message"},"type":"response_item"}\n';
  const { reader, source } = await setup(t, json + record({ type: 'user_message', message: text }), false);
  const result = await reader.search(source, 'JOINED-TAIL');
  assert.equal(result.count, 1);
  assert.equal(result.matches.length, 1);
  for (const query of ['obsolete', 'hidden-secret-marker']) assert.equal((await reader.search(source, query)).matches.length, 0);
});

test('large unlabelled replies still require completion; cancellation and changed sources preserve the old snapshot', async t => {
  const text = 'x'.repeat(4 * 1024 ** 2) + 'UNLABELLED-END';
  const unknown = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text }] } }) + '\n';
  const { reader, source, filePath } = await setup(t,
    record({ type: 'user_message', message: 'Question' }) + unknown, false);
  const first = await reader.open(source);
  assert.equal(first.conversation.messages.length, 1);
  assert.equal((await reader.search(source, 'UNLABELLED-END')).matches.length, 0);
  await fs.appendFile(filePath, record({ type: 'task_complete' }));
  const completed = await reader.open(source);
  assert.ok(completed.conversation.messages.at(-1).text.endsWith('UNLABELLED-END'));
  const work = reader.open(source);
  const rejected = assert.rejects(work, { code: 'READ_CANCELLED' });
  await reader.cancel(); await rejected;
  assert.ok((await reader.move(completed.page.readerId, 'previous')).page.hasNext);
  await fs.appendFile(filePath, record({ type: 'user_message', message: 'Changed' }));
  await assert.rejects(reader.move(completed.page.readerId, 'previous'), { code: 'SOURCE_CHANGED' });
});

test('thousands of blocks retain only the joined inline cache and keep presentation search private', async t => {
  const question = '<send_user_message_question_reply>' + JSON.stringify([
    { question: 'Choose a direction', answer: 'Clear reader', questionItemId: 'transport-only-id' },
  ]) + '</send_user_message_question_reply>';
  const blocks = Array.from({ length: 4000 }, () => ({ type: 'output_text', text: 'a'.repeat(500) }));
  const { reader, source } = await setup(t, message('assistant', blocks) + message('user', [
    { type: 'tool_result', text: 'x'.repeat(2 * 1024 ** 2) }, { text: question, type: 'input_text' },
  ]), false);
  const result = await reader.search(source, 'Clear reader');
  assert.equal(result.count, 2);
  assert.equal(result.matches.length, 1);
  assert.equal(result.incomplete, false);
  assert.equal((await reader.search(source, 'transport-only-id')).matches.length, 0);
});

test('second-pass materialization rejects a changed snapshot before publishing any text', async t => {
  const { createZstdSession } = require('../../lib/codex-page-zstd-stream');
  const { materialize } = require('../../lib/codex-page-text-capture');
  const { reader, source, filePath } = await setup(t, record({ type: 'user_message', message: 'Original' }), false);
  const stream = await createZstdSession(source, { allowPlain: true });
  const snapshot = stream.snapshot;
  await stream.close();
  await fs.appendFile(filePath, record({ type: 'user_message', message: 'Changed' }));
  const messages = [{ role: 'user', text: '', body: { length: 8, refs: [{ id: '0:0', length: 8 }] }, range: { start: 0, end: 8 } }];
  await assert.rejects(materialize(source, snapshot, messages), { code: 'SOURCE_CHANGED' });
  assert.equal(messages[0].text, '');
  assert.equal((await reader.open(source)).conversation.messages.length, 2);
});

test('nearby newlines keep fence delimiters together and search follows the adjusted boundary', async t => {
  const stride = 128 * 1024;
  const text = 'intro\n' + 'x'.repeat(stride - 10) + '\n```text\n' + 'CODE-LINE\n'.repeat(300000) + '```\nDONE';
  const { reader, source } = await setup(t, record({ type: 'task_complete', last_agent_message: text }), true);
  const first = await reader.open(source, { page: 0 });
  const second = await reader.move(first.page.readerId, 'next');
  assert.ok(first.conversation.messages[0].text.endsWith('\n'));
  assert.ok(second.conversation.messages[0].text.startsWith('```text\n'));
  assert.equal(second.conversation.messages[0].continuation.startsMidLine, false);
  const third = await reader.move(first.page.readerId, 'next');
  assert.equal(third.conversation.messages[0].continuation.fenceMarker, 3);
  const found = await reader.search(source, '```text');
  assert.equal(found.matches[0].page, 1);
});

test('malformed long records still sever completion inference and never publish their prefix', async t => {
  const unknown = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'UNPROVEN-ANSWER' }] } }) + '\n';
  const bad = '{"payload":{"message":"' + 'x'.repeat(4 * 1024 ** 2) + 'BAD-PREFIX\\q"}}\n';
  const { reader, source } = await setup(t, unknown + bad + record({ type: 'task_complete' }) +
    record({ type: 'user_message', message: 'After corruption' }), false);
  const result = await reader.open(source);
  assert.deepEqual(result.conversation.messages.map(m => m.text), ['After corruption']);
  assert.equal(result.conversation.diagnostics.malformedRecords, 1);
  for (const query of ['BAD-PREFIX', 'UNPROVEN-ANSWER']) {
    const search = await reader.search(source, query);
    assert.equal(search.matches.length, 0); assert.equal(search.incomplete, true);
  }
});
