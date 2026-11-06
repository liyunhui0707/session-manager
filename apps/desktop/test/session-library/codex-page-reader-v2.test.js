'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { createConversationReader } = require('../../lib/codex-page-reader-v2');
const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const turn = n => record('event_msg', { type: 'user_message', message: `Question ${n}` }) +
  record('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'progress-only' }] }) +
  record('event_msg', { type: 'task_complete', last_agent_message: `Answer ${n} **Markdown**` });
test('whole-conversation search indexes displayed question replies, not transport IDs or image paths', async t => {
  const { reader, source, filePath } = await setup(t);
  const question = '<send_user_message_question_reply>' + JSON.stringify([{ question: 'Which direction?', answer: 'Calm reader', questionItemId: 'hiddenroutingneedle' }]) + '</send_user_message_question_reply>';
  const image = '<image name=[Image #1] path="/tmp/hiddenpathneedle.png"></image>\nPlease inspect this layout.';
  await fs.writeFile(filePath, [question, image].map(message => record('event_msg', { type: 'user_message', message })).join(''));
  for (const query of ['Which direction', 'Calm reader', 'inspect this layout']) assert.equal((await reader.search(source, query)).matches.length, 1);
  for (const query of ['hiddenroutingneedle', 'hiddenpathneedle', 'questionItemId']) assert.equal((await reader.search(source, query)).matches.length, 0);
});
async function setup(t, compressed = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-v2-')));
  const filePath = path.join(root, 'rollout-synthetic.jsonl' + (compressed ? '.zst' : ''));
  const text = Array.from({ length: 115 }, (_, n) => turn(n)).join('');
  await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  const reader = createConversationReader();
  t.after(async () => { await reader.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, filePath, reader, source: { filePath, canonicalRoot: root, name: 'Synthetic', mode: 'codex' } };
}
for (const compressed of [false, true]) test(`opens latest, reads earlier history and searches complete ${compressed ? 'compressed' : 'plain'} conversation`, async t => {
  const { reader, source, root } = await setup(t, compressed);
  const latest = await reader.open(source);
  assert.equal(latest.page.number, 3);
  assert.equal(latest.page.hasNext, false);
  assert.equal(latest.page.latest, true);
  assert.match(latest.conversation.messages.at(-1).text, /Answer 114/);
  assert.equal(latest.conversation.messages.length, 30);
  assert.equal(JSON.stringify(latest).includes(root), false);
  const first = await reader.move(latest.page.readerId, 'first');
  assert.equal(first.page.number, 1); assert.match(first.conversation.messages[0].text, /Question 0/);
  await reader.move(latest.page.readerId, 'latest');
  const old = await reader.move(latest.page.readerId, 'previous');
  assert.match(old.conversation.messages[0].text, /Question 50/);
  const hits = await reader.search(source, 'Question 0');
  assert.equal(hits.matches.length, 1);
  assert.equal(hits.matches[0].page, 0);
  assert.equal((await reader.search(source, 'progress-only')).matches.length, 0);
  const found = await reader.open(source, { page: hits.matches[0].page });
  assert.equal(found.page.number, 1);
  assert.equal(found.page.latest, false);
});
test('refresh sees appended finals, failed reads retain old navigation, cancellation waits for exit', async t => {
  const { reader, source, filePath } = await setup(t);
  const first = await reader.open(source);
  await assert.rejects(reader.open({ ...source, filePath: filePath + '.missing' }));
  assert.equal((await reader.move(first.page.readerId, 'previous')).page.number, 2);
  await fs.appendFile(filePath, turn(115));
  const refreshed = await reader.open(source);
  assert.match(refreshed.conversation.messages.at(-1).text, /Answer 115/);
  const work = reader.open(source);
  const rejection = assert.rejects(work, { code: 'READ_CANCELLED' });
  await reader.cancel(); await rejection;
  assert.equal((await reader.move(refreshed.page.readerId, 'previous')).page.number, 2);
});
test('changed snapshots and symlinks are rejected', async t => {
  const { reader, source, filePath, root } = await setup(t);
  const page = await reader.open(source);
  await fs.appendFile(filePath, turn(116));
  await assert.rejects(reader.move(page.page.readerId, 'previous'), { code: 'SOURCE_CHANGED' });
  const link = path.join(root, 'rollout-link.jsonl'); await fs.symlink(filePath, link);
  await assert.rejects(reader.open({ ...source, filePath: link }));
});

for (const compressed of [false, true]) test(`large irrelevant fields do not make a conversation incomplete (${compressed ? 'zstd' : 'raw'})`, async t => {
  const { reader, source, filePath } = await setup(t, compressed);
  const huge = record('response_item', { type: 'function_call_output', output: 'x'.repeat(9 * 1024 ** 2) });
  const text = turn(0) + huge + turn(1) + huge.trimEnd();
  await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  const before = await fs.readFile(filePath);
  const result = await reader.open(source);
  assert.deepEqual(result.conversation.messages.map(m => m.text), ['Question 0', 'Answer 0 **Markdown**', 'Question 1', 'Answer 1 **Markdown**']);
  assert.equal(result.conversation.diagnostics.oversizedRecords, 0);
  assert.equal(result.conversation.diagnostics.oversizedMessages, 0);
  const found = await reader.search(source, 'Answer 1');
  assert.equal(found.matches.length, 1);
  assert.equal(found.incomplete, false);
  assert.deepEqual(await fs.readFile(filePath), before);
});
test('large text survives while unknown replies cannot cross a structural omission or malformed record', async t => {
  const { reader, source, filePath } = await setup(t);
  const unknown = record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'must not infer this final' }] });
  const complete = record('event_msg', { type: 'task_complete' });
  const huge = JSON.stringify({ ignored: JSON.parse('['.repeat(140) + '0' + ']'.repeat(140)) }) + '\n';
  await fs.writeFile(filePath, unknown + huge + complete + unknown + '{broken\n' + complete +
    record('event_msg', { type: 'user_message', message: 'z'.repeat(3 * 1024 * 1024) }) + turn(3));
  const result = await reader.open(source);
  assert.deepEqual(result.conversation.messages.slice(-2).map(m => m.text), ['Question 3', 'Answer 3 **Markdown**']);
  assert.ok(result.conversation.messages[0].text.startsWith('zzzz'));
  assert.equal(result.conversation.diagnostics.oversizedRecords, 1);
  assert.equal(result.conversation.diagnostics.oversizedMessages, 0);
  assert.equal(result.conversation.diagnostics.malformedRecords, 1);
  assert.equal((await reader.search(source, 'must not infer')).matches.length, 0);
});
test('an explicitly final reply before an unreadable record remains visible', async t => {
  const { reader, source, filePath } = await setup(t);
  await fs.writeFile(filePath, record('event_msg', { type: 'user_message', message: 'Keep my answer' }) +
    record('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Explicit final before gap' }] }) +
    record('response_item', { type: 'function_call_output', output: 'x'.repeat(9 * 1024 ** 2) }) + turn(4));
  const result = await reader.open(source);
  assert.deepEqual(result.conversation.messages.map(m => m.text), ['Keep my answer', 'Explicit final before gap', 'Question 4', 'Answer 4 **Markdown**']);
});
test('oversize recovery does not accept a truncated compressed stream or replace the old snapshot', async t => {
  const { reader, source, filePath } = await setup(t, true);
  const previous = await reader.open(source);
  const bad = filePath.replace('.jsonl.zst', '-corrupt.jsonl.zst');
  const text = record('response_item', { type: 'function_call_output', output: 'x'.repeat(9 * 1024 ** 2) }) + turn(9);
  const data = zstdCompressSync(text);
  await fs.writeFile(bad, data.subarray(0, data.length - 3));
  await assert.rejects(reader.open({ ...source, filePath: bad }), { code: 'DECOMPRESSION_FAILED' });
  assert.equal((await reader.move(previous.page.readerId, 'previous')).page.number, 2);
});

for (const compressed of [false, true]) test(`large image fields retain prompt text and full search (${compressed ? 'zstd' : 'raw'})`, async t => {
  const { reader, source, filePath } = await setup(t, compressed);
  const content = [{ type: 'input_text', text: 'Before picture 中文' },
    { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(10 * 1024 ** 2) },
    { type: 'input_text', text: 'After picture searchable needle' }];
  // Put record and block discriminators after large data: field order is irrelevant.
  const text = JSON.stringify({ payload: { content, role: 'user', type: 'message' }, type: 'response_item' }) + '\n' +
    record('event_msg', { type: 'task_complete', last_agent_message: 'Recovered answer' });
  await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  const before = await fs.readFile(filePath);
  const result = await reader.open(source);
  assert.deepEqual(result.conversation.messages.map(m => m.text), ['Before picture 中文\n\nAfter picture searchable needle', 'Recovered answer']);
  assert.equal(result.conversation.diagnostics.oversizedRecords, 0);
  const found = await reader.search(source, 'searchable needle');
  assert.equal(found.matches.length, 1); assert.equal(found.incomplete, false);
  assert.deepEqual(await fs.readFile(filePath), before);
});
for (const compressed of [false, true]) test(`invalid ignored data is drained to a record boundary (${compressed ? 'zstd' : 'raw'})`, async t => {
  const { reader, source, filePath } = await setup(t, compressed);
  const bad = '{"ignored":"' + 'A'.repeat(9 * 1024 ** 2) + '\\q"}';
  const text = turn(1) + bad + '\n' + turn(2) + bad;
  await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  const result = await reader.open(source);
  assert.equal(result.conversation.messages.length, 4);
  assert.equal(result.conversation.diagnostics.malformedRecords, 1);
  assert.equal(result.conversation.diagnostics.unparsedFinalRecord, 1);
  assert.equal((await reader.search(source, 'Answer 2')).incomplete, true);
});
test('heavily escaped supported text fits the bounded worker and preserves exact Unicode', async t => {
  const { reader, source, filePath } = await setup(t);
  const text = '汉'.repeat(150000);
  await fs.writeFile(filePath, '{"type":"event_msg","payload":{"type":"user_message","message":"' + '\\u6c49'.repeat(150000) + '"}}\n');
  const result = await reader.open(source);
  assert.equal(result.conversation.messages[0].text, text);
  assert.equal(result.conversation.diagnostics.oversizedMessages, 0);
});
for (const compressed of [false, true]) test(`large visible replies remain complete, paged and searchable (${compressed ? 'zstd' : 'raw'})`, async t => {
  const { reader, source, filePath } = await setup(t, compressed);
  const answer = '```text\n' + 'Readable 中文 line\n'.repeat(42000) + '```\n\nLAST-NEEDLE';
  const text = record('event_msg', { type: 'user_message', message: 'Explain in detail' }) +
    record('event_msg', { type: 'task_complete', last_agent_message: answer });
  await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  const before = await fs.readFile(filePath), latest = await reader.open(source);
  assert.ok(latest.page.number > 1);
  assert.ok(latest.conversation.messages.at(-1).text.endsWith('LAST-NEEDLE'));
  assert.equal(latest.conversation.diagnostics.oversizedMessages, 0);
  const pieces = [...latest.conversation.messages];
  let current = latest;
  while (current.page.hasPrevious) {
    current = await reader.move(latest.page.readerId, 'previous');
    pieces.unshift(...current.conversation.messages);
  }
  assert.equal(pieces.filter(p => p.role === 'assistant').map(p => p.text).join(''), answer);
  assert.ok(pieces.every(p => Buffer.byteLength(p.text) <= 512 * 1024));
  const found = await reader.search(source, 'LAST-NEEDLE');
  assert.equal(found.matches.length, 1); assert.equal(found.incomplete, false);
  const hit = await reader.open(source, { page: found.matches[0].page });
  assert.ok(hit.conversation.messages[found.matches[0].message].text.includes('LAST-NEEDLE'));
  assert.deepEqual(await fs.readFile(filePath), before);
});
test('whole-body search finds a query across a message-part boundary once', async t => {
  const { reader, source, filePath } = await setup(t);
  const text = 'x'.repeat(256 * 1024 - 5) + 'CROSS-BOUNDARY' + 'y'.repeat(600 * 1024);
  await fs.writeFile(filePath, record('event_msg', { type: 'task_complete', last_agent_message: text }));
  const result = await reader.search(source, 'CROSS-BOUNDARY');
  assert.equal(result.matches.length, 1); assert.equal(result.incomplete, false);
  assert.equal(result.count, 1);
  const hit = await reader.open(source, { page: result.matches[0].page });
  const next = await reader.move(hit.page.readerId, 'next');
  assert.ok((hit.conversation.messages.at(-1).text + next.conversation.messages[0].text).includes('CROSS-BOUNDARY'));
});
test('large escaped text is segmented inside the worker budget without loss', async t => {
  const { reader, source, filePath } = await setup(t);
  const text = '汉'.repeat(600000);
  await fs.writeFile(filePath, '{"type":"event_msg","payload":{"type":"user_message","message":"' + '\\u6c49'.repeat(600000) + '"}}\n');
  const result = await reader.open(source);
  assert.ok(result.page.number > 1);
  assert.equal(result.conversation.diagnostics.oversizedMessages, 0);
  assert.equal((await reader.search(source, '汉汉')).count, 1);
});
test('case-fold expansion does not move a search hit to the wrong long-message part', async t => {
  const { reader, source, filePath } = await setup(t);
  const text = 'İ'.repeat(300000) + '\n\nNEEDLE-HERE\n\n' + 'x'.repeat(300000);
  await fs.writeFile(filePath, record('event_msg', { type: 'task_complete', last_agent_message: text }));
  const result = await reader.search(source, 'needle-here');
  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].snippet.includes('NEEDLE-HERE'));
  const hit = await reader.open(source, { page: result.matches[0].page });
  assert.ok(hit.conversation.messages[result.matches[0].message].text.includes('NEEDLE-HERE'));
});
test('escape-heavy text above eight physical MiB survives the bounded worker', async t => {
  const { reader, source, filePath } = await setup(t);
  await fs.writeFile(filePath, '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"' + '\\u0061'.repeat(1500000) + 'TAIL-ESCAPED"}}\n');
  const result = await reader.open(source);
  assert.equal(result.conversation.diagnostics.oversizedMessages, 0);
  assert.ok(result.conversation.messages.at(-1).text.endsWith('TAIL-ESCAPED'));
});
