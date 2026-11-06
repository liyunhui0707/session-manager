'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { createConversationReader } = require('../../lib/codex-page-reader-v2');
const { createPageWindow, CACHE_BYTES } = require('../../lib/codex-page-window');
const { readConversation } = require('../../lib/codex-page-reader-task');
const text = Array.from({ length: 620 }, (_, n) => JSON.stringify({ type: 'event_msg',
  payload: { type: 'user_message', message: `Prompt ${n}` } }) + '\n').join('');
async function setup(t, compressed) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-page-cache-')));
  const filePath = path.join(root, 'rollout-cache.jsonl' + (compressed ? '.zst' : ''));
  await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  const reader = createConversationReader();
  t.after(async () => { await reader.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { reader, filePath, source: { filePath, canonicalRoot: root, name: 'Synthetic' } };
}
for (const compressed of [false, true]) test(`neighbor navigation avoids scans and preserves content (${compressed})`, async t => {
  const { reader, source } = await setup(t, compressed);
  const latest = await reader.open(source), id = latest.page.readerId;
  assert.equal(latest.page.number, 7);
  for (const page of [6, 5]) {
    const result = await reader.move(id, 'previous');
    assert.equal(result.page.number, page);
    assert.equal(result.conversation.messages[0].text, `Prompt ${(page - 1) * 100}`);
    assert.equal('window' in result, false);
  }
  assert.deepEqual(reader.getReadStats(), { scans: 1, validations: 2 });
  assert.equal((await reader.move(id, 'previous')).page.number, 4);
  assert.deepEqual(reader.getReadStats(), { scans: 2, validations: 2 });
  assert.equal((await reader.move(id, 'next')).page.number, 5);
  assert.equal((await reader.move(id, 'previous')).page.number, 4);
  assert.deepEqual(reader.getReadStats(), { scans: 2, validations: 4 });
  const found = await reader.open(source, { page: 1 });
  assert.equal((await reader.move(found.page.readerId, 'next')).page.number, 3);
  assert.equal(reader.getReadStats().scans, 3);
});
for (const change of ['append', 'replace', 'symlink', 'truncate']) test(`cached page rejects ${change}`, async t => {
  const { reader, source, filePath } = await setup(t, false);
  const latest = await reader.open(source), id = latest.page.readerId;
  if (change === 'append') await fs.appendFile(filePath, '\n');
  if (change === 'truncate') await fs.truncate(filePath, 0);
  if (change === 'replace' || change === 'symlink') {
    await fs.rename(filePath, filePath + '.old');
    if (change === 'replace') await fs.writeFile(filePath, text);
    else await fs.symlink(filePath + '.old', filePath);
  }
  await assert.rejects(reader.move(id, 'previous'));
  if (change !== 'symlink') assert.equal((await reader.move(id, 'latest')).page.latest, true);
});
test('cached validation uses existing cancellation and busy lifecycle', async t => {
  const { reader, source } = await setup(t, false);
  const latest = await reader.open(source), id = latest.page.readerId;
  const pending = reader.move(id, 'previous');
  const rejected = assert.rejects(pending, { code: 'READ_CANCELLED' });
  await assert.rejects(reader.move(id, 'previous'), { code: 'READ_BUSY' });
  await reader.cancel(); await rejected;
  assert.equal((await reader.move(id, 'previous')).page.number, 6);
  await reader.close();
  await assert.rejects(reader.move(id, 'previous'), { code: 'STALE_READER' });
});
test('renaming a catalog title retains valid pages; moving the source out rejects them', async t => {
  const { reader, source, filePath } = await setup(t, false);
  const latest = await reader.open(source), id = latest.page.readerId;
  reader.rebind({ ...source, name: 'Renamed synthetic conversation' });
  const page = await reader.move(id, 'previous');
  assert.equal(page.name, 'Renamed synthetic conversation');
  assert.equal(reader.getReadStats().scans, 1);
  await fs.rename(filePath, filePath + '.archived');
  await assert.rejects(reader.move(id, 'previous'));
});
test('window budget evicts retained pages rather than growing with navigation history', () => {
  const window = createPageWindow();
  for (let n = 0; n < 12; n++) window.add(n, [{ role: 'user', text: 'x'.repeat(3 * 1024 * 1024) }]);
  assert.deepEqual(window.entries().map(p => p.number), [10, 11]);
  assert.ok(Buffer.byteLength(JSON.stringify(window.entries())) < CACHE_BYTES);
});
test('page window bounds count and estimated materialized bytes, including descriptor text', () => {
  const window = createPageWindow();
  for (let n = 0; n < 100; n++) window.add(n, [{ role: 'user', text: 'small' }]);
  assert.deepEqual(window.entries().map(p => p.number), [97, 98, 99]);
  window.add(100, [{ role: 'user', text: 'x'.repeat(CACHE_BYTES) }]);
  assert.equal(window.entries().some(p => p.number === 100), false);
  window.add(101, [{ role: 'user', text: '', body: { refs: [] }, range: { start: 0, end: CACHE_BYTES } }]);
  assert.equal(window.entries().some(p => p.number === 101), false);
  const targeted = createPageWindow(10);
  for (let n = 0; n < 100; n++) targeted.add(n, [{ role: 'user', text: 'small' }]);
  assert.deepEqual(targeted.entries().map(p => p.number), [9, 10, 11]);
});
test('snapshot validation opens the source safely without reading transcript bytes', async t => {
  const { source } = await setup(t, true);
  const scanned = await readConversation({ source });
  let reads = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read;
    t.mock.method(handle, 'read', function (...readArgs) { reads++; return read.apply(this, readArgs); });
    return handle;
  });
  const result = await readConversation({ source: { ...source, snapshot: scanned.snapshot }, validateOnly: true });
  assert.deepEqual(result, { snapshot: scanned.snapshot });
  assert.equal(reads, 0);
});
for (const compressed of [false, true]) test(`descriptor-backed cached pages preserve Unicode and fence context (${compressed})`, async t => {
  const { reader, source, filePath } = await setup(t, compressed);
  const body = '```text\n' + '中文🙂\\\t\n'.repeat(180000) + '\n```';
  const raw = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: body } }) + '\n';
  await fs.writeFile(filePath, compressed ? zstdCompressSync(raw) : raw);
  const latest = await reader.open(source);
  const cached = await reader.move(latest.page.readerId, 'previous');
  assert.deepEqual(reader.getReadStats(), { scans: 1, validations: 1 });
  const direct = await readConversation({ source, page: cached.page.number - 1 });
  assert.deepEqual(cached.conversation, direct.conversation);
  assert.ok(Buffer.byteLength(JSON.stringify(direct.window)) <= CACHE_BYTES);
  assert.ok(direct.window.length <= 3);
});
