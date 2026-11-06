'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { readConversation } = require('../../lib/codex-page-reader-task');
const { createConversationReader } = require('../../lib/codex-page-reader-v2');
const { CHECKPOINT_BYTES } = require('../../lib/codex-page-append');
const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const prompt = text => row('event_msg', { type: 'user_message', message: text });
const reply = (text, phase = 'final_answer') => row('response_item', { type: 'message', role: 'assistant', ...(phase ? { phase } : {}), content: [{ type: 'output_text', text }] });
const complete = text => row('event_msg', { type: 'task_complete', ...(text ? { last_agent_message: text } : {}) });
const initial = Array.from({ length: 120 }, (_, i) => prompt(`Question ${i}`) + reply(`Answer ${i}`) + complete(`Answer ${i}`)).join('');
async function setup(t, raw = initial, compressed = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-append-')));
  const filePath = path.join(root, 'rollout-append.jsonl' + (compressed ? '.zst' : ''));
  await fs.writeFile(filePath, compressed ? zstdCompressSync(raw) : raw);
  const reader = createConversationReader();
  t.after(async () => { await reader.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { reader, filePath, source: { filePath, canonicalRoot: root, name: 'Synthetic append' } };
}
function equivalent(a, b) {
  for (const key of ['conversation', 'number', 'pages', 'count', 'waiting', 'ambiguous', 'incomplete']) assert.deepEqual(a[key], b[key], key);
}
test('appending a turn parses only new records and equals a full read', async t => {
  const { source, filePath } = await setup(t);
  const first = await readConversation({ source });
  assert.ok(first.append);
  const checkpoint = JSON.stringify(first.append);
  const added = prompt('New 中文🙂') + reply('Final **Markdown**') + complete('Final **Markdown**');
  await fs.appendFile(filePath, added);
  const incremental = await readConversation({ source, append: first.append });
  equivalent(incremental, await readConversation({ source }));
  assert.deepEqual(incremental.work, { incremental: true, parsedRecords: 3, verifiedPrefixBytes: Buffer.byteLength(initial) });
  assert.equal(incremental.conversation.messages.at(-1).text, 'Final **Markdown**');
  assert.equal(JSON.stringify(first.append), checkpoint);
});
for (const [name, head, tail] of [
  ['completion mirror', prompt('Q') + reply('A'), complete('A')],
  ['unlabelled final', prompt('Q') + reply('A', ''), complete()],
  ['user mirror', prompt('Q'), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Q' }] }) + reply('A')],
  ['pending prompt', row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Q' }] }), prompt('Q') + reply('A')],
  ['revised final', prompt('Q') + reply('old final'), reply('new final') + complete()],
  ['aborted', prompt('Q') + reply('unknown', ''), row('event_msg', { type: 'turn_aborted' })],
]) test(`append checkpoint preserves pre-EOF turn semantics: ${name}`, async t => {
  const { source, filePath } = await setup(t, initial + head);
  let result = await readConversation({ source });
  assert.ok(result.append);
  await fs.appendFile(filePath, tail);
  result = await readConversation({ source, append: result.append });
  assert.equal(result.work.incremental, true);
  equivalent(result, await readConversation({ source }));
  await fs.appendFile(filePath, prompt('Next') + reply('Done') + complete());
  equivalent(await readConversation({ source, append: result.append }), await readConversation({ source }));
});
for (const kind of ['replace', 'truncate', 'rewrite-prefix']) test(`unsafe append falls back to full parsing: ${kind}`, async t => {
  const { source, filePath } = await setup(t);
  const first = await readConversation({ source });
  let raw;
  if (kind === 'replace') { await fs.rename(filePath, filePath + '.old'); raw = initial + prompt('Replacement'); }
  if (kind === 'truncate') raw = prompt('Truncated');
  if (kind === 'rewrite-prefix') raw = initial.replace('Question 0', 'Modified 0') + prompt('Growth');
  await fs.writeFile(filePath, raw);
  const result = await readConversation({ source, append: first.append });
  assert.equal(result.work.incremental, false);
  equivalent(result, await readConversation({ source }));
});
test('partial last records fall back and become complete without duplicated messages', async t => {
  const { source, filePath } = await setup(t);
  const first = await readConversation({ source });
  const final = reply('完成🙂');
  await fs.appendFile(filePath, Buffer.from(final).subarray(0, 40));
  const partial = await readConversation({ source, append: first.append });
  assert.equal(partial.append, null);
  equivalent(partial, await readConversation({ source }));
  await fs.appendFile(filePath, Buffer.from(final).subarray(40));
  const result = await readConversation({ source, append: partial.append });
  assert.equal(result.work.incremental, false);
  equivalent(result, await readConversation({ source }));
});
test('compressed sources and oversized checkpoint state use full reads', async t => {
  const compressed = await setup(t, initial, true);
  const first = await readConversation({ source: compressed.source });
  assert.equal(first.append, null);
  const large = await setup(t, prompt('x'.repeat(3 * 1024 ** 2)));
  const result = await readConversation({ source: large.source });
  assert.equal(result.append, null);
  assert.ok(result.conversation.messages.length);
});
test('public reader reload/latest reuse append state but never expose it', async t => {
  const { source, reader, filePath } = await setup(t);
  await reader.open(source);
  await fs.appendFile(filePath, prompt('new'));
  const reloaded = await reader.open(source);
  assert.equal(reader.getReadWork().incremental, true);
  assert.equal('append' in reloaded, false);
  assert.equal('work' in reloaded, false);
  await fs.appendFile(filePath, reply('final') + complete());
  const latest = await reader.move(reloaded.page.readerId, 'latest');
  assert.equal(reader.getReadWork().parsedRecords, 2);
  assert.equal(latest.conversation.messages.at(-1).text, 'final');
  await reader.close(); await reader.open(source);
  assert.equal(reader.getReadWork().incremental, false);
});
test('large newly appended text uses global record references and matches full extraction', async t => {
  const { source, filePath } = await setup(t);
  const first = await readConversation({ source });
  await fs.appendFile(filePath, prompt('Large reply please') + reply('```text\n' + '中文🙂\n'.repeat(350000) + '\n```') + complete());
  const result = await readConversation({ source, append: first.append });
  assert.equal(result.work.incremental, true);
  assert.equal(result.work.parsedRecords, 3);
  equivalent(result, await readConversation({ source }));
  assert.equal(result.append, null);
});
test('repeated appends cross page boundaries with bounded checkpoints and complete search', async t => {
  const { source, reader, filePath } = await setup(t);
  let result = await readConversation({ source });
  for (let n = 0; n < 8; n++) {
    const extra = Array.from({ length: 40 }, (_, i) => prompt(`Round ${n} question ${i}`) + reply(`Round ${n} answer ${i}`) + complete()).join('');
    await fs.appendFile(filePath, extra);
    result = await readConversation({ source, append: result.append });
    assert.equal(result.work.parsedRecords, 120);
    assert.ok(Buffer.byteLength(JSON.stringify(result.append)) <= CHECKPOINT_BYTES);
    equivalent(result, await readConversation({ source }));
  }
  await reader.open(source);
  const searched = await reader.search(source, 'Question 0');
  assert.equal(searched.matches.length, 9);
  assert.equal(searched.work.incremental, false);
});
test('append work can be cancelled and failed reads preserve the previous reader', async t => {
  const { source, reader, filePath } = await setup(t);
  const opened = await reader.open(source);
  const pending = reader.move(opened.page.readerId, 'latest');
  const rejected = assert.rejects(pending, { code: 'READ_CANCELLED' });
  await reader.cancel(); await rejected;
  await fs.appendFile(filePath, prompt('After cancellation'));
  assert.equal((await reader.move(opened.page.readerId, 'latest')).conversation.messages.at(-1).text, 'After cancellation');
  assert.equal(reader.getReadWork().incremental, true);
  await fs.rename(filePath, filePath + '.moved');
  await fs.symlink(filePath + '.moved', filePath);
  await assert.rejects(reader.move(opened.page.readerId, 'latest'));
});
test('source mutation during prefix verification rejects rather than publishing a mixed snapshot', async t => {
  const { source, filePath } = await setup(t);
  const first = await readConversation({ source });
  await fs.appendFile(filePath, prompt('New'));
  const open = fs.open; let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read;
    t.mock.method(handle, 'read', async function (...readArgs) {
      const result = await read.apply(this, readArgs);
      if (!changed) { changed = true; await fs.appendFile(filePath, '\n'); }
      return result;
    });
    return handle;
  });
  await assert.rejects(readConversation({ source, append: first.append }), { code: 'SOURCE_CHANGED' });
  assert.equal(changed, true);
});

for (const compressed of [false, true]) test(`unchanged latest reuses verified pages without scanning or prefix hashing (${compressed})`, async t => {
  const { reader, source, filePath } = await setup(t, initial, compressed);
  const first = await reader.open(source);
  const same = await reader.move(first.page.readerId, 'latest');
  assert.deepEqual(same.conversation, first.conversation);
  assert.deepEqual(reader.getReadStats(), { scans: 1, validations: 1 });
  assert.equal(reader.getReadWork().parsedRecords, 0);
  const reopened = await reader.open(source);
  assert.deepEqual(reopened.conversation, first.conversation);
  assert.deepEqual(reader.getReadStats(), { scans: 1, validations: 2 });
  await fs.writeFile(filePath, compressed ? zstdCompressSync(prompt('Rewritten')) : prompt('Rewritten'));
  const changed = await reader.move(reopened.page.readerId, 'latest');
  assert.equal(changed.conversation.messages.at(-1).text, 'Rewritten');
  assert.equal(reader.getReadStats().scans, 2);
});

test('immediate cancellation closes first open and a latest cache miss', async t => {
  const { reader, source } = await setup(t, Array.from({ length: 600 }, (_, n) => prompt('Q' + n)).join(''));
  const first = reader.open(source), rejected = assert.rejects(first, { code: 'READ_CANCELLED' });
  assert.equal(await reader.cancel(), true); await rejected;
  await reader.open(source, { page: 0 });
  const latest = reader.open(source), latestRejected = assert.rejects(latest, { code: 'READ_CANCELLED' });
  assert.equal(await reader.cancel(), true); await latestRejected;
});
