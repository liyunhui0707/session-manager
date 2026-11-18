'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { readConversation } = require('../../lib/codex-page-reader-task');
const { createConversationReader } = require('../../lib/codex-page-reader-v2');
const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const prompt = text => row('event_msg', { type: 'user_message', message: text });
const response = (role, text) => row('response_item', { type: 'message', role,
  phase: role === 'assistant' ? 'final_answer' : undefined, content: [{ type: 'input_text', text }] });
const done = text => row('event_msg', { type: 'task_complete', last_agent_message: text });
const question = answer => '<send_user_message_question_reply>' + JSON.stringify([
  { question: 'HIDDEN-QUESTION', answer, questionItemId: 'HIDDEN-ID' },
]) + '</send_user_message_question_reply>';
async function setup(t, raw, compressed = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-question-filter-')));
  const filePath = path.join(root, 'rollout-synthetic.jsonl' + (compressed ? '.zst' : ''));
  await fs.writeFile(filePath, compressed ? zstdCompressSync(raw) : raw);
  const reader = createConversationReader();
  t.after(async () => { await reader.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { reader, source: { filePath, canonicalRoot: root }, filePath };
}
for (const compressed of [false, true]) test(`question cards do not consume pages or search hits (${compressed ? 'zstd' : 'plain'})`, async t => {
  const hidden = question('HIDDEN-ANSWER');
  const raw = prompt('Original prompt') + Array.from({ length: 120 }, () => prompt(hidden) + response('user', hidden)).join('') +
    prompt('允许') + done('Final answer');
  const { reader, source, filePath } = await setup(t, raw, compressed);
  const before = await fs.readFile(filePath), latest = await reader.open(source);
  assert.equal(latest.page.pages, 1);
  assert.deepEqual(latest.conversation.messages.map(m => m.text), ['Original prompt', '允许', 'Final answer']);
  assert.equal(latest.page.waiting, false);
  for (const term of ['HIDDEN-QUESTION', 'HIDDEN-ANSWER', 'HIDDEN-ID']) {
    const result = await reader.search(source, term);
    assert.equal(result.count, 3); assert.equal(result.matches.length, 0);
  }
  const hit = (await reader.search(source, 'Final answer')).matches[0];
  const page = await reader.open(source, { page: hit.page });
  assert.equal(page.conversation.messages[hit.message].text, 'Final answer');
  assert.deepEqual(await fs.readFile(filePath), before);
});
test('filtering only recognized user envelopes preserves literal examples and unknown formats', async t => {
  const valid = question('hidden');
  const keep = ['已完成', '```\n' + valid + '\n```', 'Example: ' + valid,
    '<send_user_message_question_reply>{broken}</send_user_message_question_reply>',
    '<send_user_message_question_reply>[{"question":"q","answer":"a","future":true}]</send_user_message_question_reply>'];
  const { reader, source } = await setup(t, keep.map(prompt).join('') + done(valid));
  const result = await reader.open(source);
  assert.deepEqual(result.conversation.messages.map(m => m.text), [...keep, valid]);
});
test('incremental reads preserve final replies across hidden questions and match full reads', async t => {
  const hidden = question('x'.repeat(600000));
  const { source, filePath } = await setup(t, prompt('Start') + response('user', hidden));
  const first = await readConversation({ source });
  assert.deepEqual(first.conversation.messages.map(m => m.text), ['Start']);
  await fs.appendFile(filePath, prompt(hidden) + done('Final after confirmation'));
  const next = await readConversation({ source, append: first.append });
  const full = await readConversation({ source });
  assert.equal(next.work.incremental, true);
  for (const key of ['conversation', 'count', 'pages', 'waiting']) assert.deepEqual(next[key], full[key]);
  assert.deepEqual(next.conversation.messages.map(m => m.text), ['Start', 'Final after confirmation']);
});
test('question-only conversations have no cards and a single empty page', async t => {
  const { reader, source } = await setup(t, response('user', question('')));
  const page = await reader.open(source);
  assert.equal(page.page.pages, 1);
  assert.deepEqual(page.conversation.messages, []);
});
