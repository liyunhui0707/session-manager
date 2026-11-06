'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createCodexPagedReader } = require('../../tools/legacy-reader/codex-paged-reader');
const { scanCodexSource } = require('../../lib/codex-source-catalog');
const id = '11111111-1111-4111-8111-111111111111';
const name = `rollout-2026-11-03T00-00-00-${id}.jsonl`;
const record = i => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: i % 2 ? 'assistant' : 'user', content: [{ type: 'input_text', text: `消息 ${i}\n\n**Markdown**` }] } }) + '\n';
async function setup(t, content = Array.from({ length: 215 }, (_, i) => record(i)).join('')) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-zstd-')));
  const dir = path.join(root, 'sessions/2026/11/03');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name + '.zst');
  await fs.writeFile(filePath, zlib.zstdCompressSync(content));
  const reader = createCodexPagedReader();
  t.after(async () => { await reader.close?.(); await reader.cancel(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dir, filePath, reader, source: { filePath, canonicalRoot: root, name: 'Renamed synthetic' } };
}
test('compressed active/archive catalog entries need no body reads and plain copies win deterministically', async t => {
  const f = await setup(t);
  await fs.chmod(f.filePath, 0);
  await fs.mkdir(path.join(f.root, 'archived_sessions'));
  await fs.writeFile(path.join(f.root, 'archived_sessions', name + '.zst'), 'not decoded during scanning');
  await fs.writeFile(path.join(f.root, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Saved rename' }));
  let catalog = await scanCodexSource(f.root);
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].area, 'active');
  assert.equal(catalog.entries[0].title, 'Saved rename');
  assert.equal(catalog.diagnostics.duplicates, 1);
  await fs.writeFile(path.join(f.dir, name), record(0));
  // A compressed copy's newer mtime must not displace an existing plain copy.
  await fs.utimes(f.filePath, new Date('2030-01-01'), new Date('2030-01-01'));
  catalog = await scanCodexSource(f.root);
  assert.equal(catalog.entries[0].filePath, path.join(f.dir, name));
  assert.equal(catalog.diagnostics.duplicates, 2);
});
test('compressed reader pages in order, goes back, reloads, and exposes no source paths or false percentages', async t => {
  const { reader, source, root } = await setup(t);
  const first = await reader.open(source);
  assert.equal(first.conversation.messages.length, 100);
  assert.equal(first.page.compressed, true);
  assert.equal(first.page.totalBytes, null);
  assert.equal(JSON.stringify(first).includes(root), false);
  const second = await reader.move(first.page.readerId, 'next');
  assert.match(second.conversation.messages[0].text, /消息 100/);
  const third = await reader.move(first.page.readerId, 'next');
  assert.equal(third.conversation.messages.length, 15);
  assert.equal(third.page.hasNext, false);
  const back = await reader.move(first.page.readerId, 'previous');
  assert.deepEqual(back.conversation, second.conversation);
  const reloaded = await reader.open(source);
  assert.equal(reloaded.page.number, 1);
  await assert.rejects(reader.move(first.page.readerId, 'next'), { code: 'STALE_READER' });
});
test('compressed cancellation and failed open preserve the accepted snapshot and allow retry', async t => {
  const { reader, source, filePath } = await setup(t);
  const first = await reader.open(source);
  const pending = reader.move(first.page.readerId, 'next');
  const rejected = assert.rejects(pending, { code: 'READ_CANCELLED' });
  assert.equal(await reader.cancel(), true);
  await rejected;
  assert.equal((await reader.move(first.page.readerId, 'next')).page.number, 2);
  await assert.rejects(reader.open({ ...source, filePath: filePath + '.missing.zst' }));
  assert.equal((await reader.move(first.page.readerId, 'next')).page.number, 3);
});
test('compressed source replacement and symlinks fail closed', async t => {
  const { reader, source, filePath, dir } = await setup(t);
  const first = await reader.open(source);
  const link = path.join(dir, 'rollout-link.jsonl.zst');
  await fs.symlink(filePath, link);
  await assert.rejects(reader.open({ ...source, filePath: link }));
  await fs.appendFile(filePath, 'changed');
  await assert.rejects(reader.move(first.page.readerId, 'next'), { code: 'SOURCE_CHANGED' });
});
test('invalid and truncated compressed streams are explicit failures, not successful partial transcripts', async t => {
  const { reader, source, filePath } = await setup(t, record(0));
  const good = await fs.readFile(filePath);
  for (const bytes of [Buffer.from('not zstd'), good.subarray(0, good.length - 2)]) {
    await fs.writeFile(filePath, bytes);
    await assert.rejects(reader.open(source), { code: 'DECOMPRESSION_FAILED' });
  }
});
test('compressed concatenated frames preserve UTF-8 and record boundaries', async t => {
  const { reader, source, filePath } = await setup(t);
  const all = Buffer.from(record(0) + record(1));
  const split = all.indexOf(Buffer.from('消息')) + 1;
  await fs.writeFile(filePath, Buffer.concat([zlib.zstdCompressSync(all.subarray(0, split)), zlib.zstdCompressSync(all.subarray(split))]));
  const page = await reader.open(source);
  assert.equal(page.conversation.messages.length, 2);
  assert.match(page.conversation.messages[0].text, /消息 0/);
});
test('compressed record and rendered-message limits remain enforced', async t => {
  const { reader, source, filePath } = await setup(t, 'x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(reader.open(source), { code: 'RECORD_TOO_LARGE' });
  const text = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(512 * 1024 + 1) }] } });
  await fs.writeFile(filePath, zlib.zstdCompressSync(text));
  await assert.rejects(reader.open(source), { code: 'MESSAGE_TOO_LARGE' });
});

test('decoder rejects excessive window requests as a bounded resource limit', async t => {
  const { reader, source, filePath } = await setup(t);
  const bytes = zlib.zstdCompressSync(Buffer.alloc(9 * 1024 * 1024, 32), {
    params: { [zlib.constants.ZSTD_c_windowLog]: 24 },
  });
  await fs.writeFile(filePath, bytes);
  await assert.rejects(reader.open(source), { code: 'DECOMPRESSION_LIMIT' });
});
test('decoded-byte budget and sustained forward progress are bounded independently of compressed size', async t => {
  const { createZstdSession } = require('../../lib/codex-page-zstd-stream');
  const { source } = await setup(t);
  const limited = await createZstdSession(source, { maxDecodedBytes: 128 });
  try { await assert.rejects(limited.read(0), { code: 'DECOMPRESSION_LIMIT' }); }
  finally { await limited.close(); }
  const stream = await createZstdSession(source);
  try {
    const first = await stream.read(0);
    const second = await stream.read(first.nextOffset, first.snapshot);
    assert.ok(second.nextOffset > first.nextOffset);
    assert.equal(stream.cursor, second.nextOffset);
    assert.ok(second.decodedBytes - first.decodedBytes <= 1024 * 1024);
    assert.match(second.conversation.messages[0].text, /消息 100/);
  } finally { await stream.close(); }
});
