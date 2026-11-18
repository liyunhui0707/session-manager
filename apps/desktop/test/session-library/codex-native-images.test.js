'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { createConversationReader } = require('../../lib/codex-page-reader-v2');
const { registerConversationImages } = require('../../lib/codex-page-images');
const { createSessionSourceState } = require('../../lib/session-source-state');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7s8AAAAASUVORK5CYII=', 'base64');
const url = 'data:image/png;base64,' + PNG.toString('base64');
const event = (message, extra = {}) => ({ type: 'event_msg', payload: { type: 'user_message', message, ...extra } });
const input = (text, image = url) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
  { type: 'input_text', text }, { type: 'input_image', image_url: image },
] } });
const final = { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'final answer' } };
async function fixture(t, compressed = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-native-images-')));
  const filePath = path.join(root, 'rollout-synthetic.jsonl' + (compressed ? '.zst' : ''));
  const reader = createConversationReader(), state = createSessionSourceState(() => true), handlers = new Map();
  registerConversationImages(state.guard({ handle: (name, fn) => handlers.set(name, fn) }), {
    reader, sourceState: state, thumbnail: async bytes => bytes,
  });
  t.after(async () => { await reader.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, filePath, reader,
    async open(records) {
      const bytes = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n');
      await fs.writeFile(filePath, compressed ? zstdCompressSync(bytes) : bytes);
      const result = await reader.open({ filePath, canonicalRoot: root, mode: 'codex' }); state.useCodex(filePath);
      return result;
    },
    read(result, message = 0, image = 0) { return handlers.get('codexImage:read')({}, {
      readerId: result.page.readerId, page: result.page.number, message, image, size: 'original',
    }); },
  };
}
for (const compressed of [false, true]) test(`native images remain lazy and preview through main-owned references (${compressed ? 'zstd' : 'plain'})`, async t => {
  const f = await fixture(t, compressed), page = await f.open([input('[Image #1] inspect'), final]);
  assert.equal(page.conversation.messages[0].imageCount, 1);
  assert.ok(!JSON.stringify(page).includes('base64'));
  assert.ok(!JSON.stringify(page).includes('image_url'));
  const before = await fs.readFile(f.filePath), result = await f.read(page);
  assert.equal(result.ok, true); assert.deepEqual(Buffer.from(result.bytes), PNG);
  assert.deepEqual(await fs.readFile(f.filePath), before);
});
test('event and response mirrors preserve image metadata in either order without duplicate prompts', async t => {
  const f = await fixture(t);
  for (const records of [[event('[Image #1]'), input('[Image #1]')], [input('[Image #1]'), event('[Image #1]')]]) {
    const page = await f.open([...records, final]);
    assert.equal(page.conversation.messages.length, 2);
    assert.equal(page.conversation.messages[0].imageCount, 1);
    assert.equal((await f.read(page)).ok, true);
  }
  const repeated = await f.open([event('yes'), event('yes'), final]);
  assert.equal(repeated.conversation.messages.filter(m => m.role === 'user').length, 2);
});
test('image-only prompts and event attachments retain order and use existing file protections', async t => {
  const f = await fixture(t), image = path.join(f.root, 'synthetic.png'); await fs.writeFile(image, PNG);
  const page = await f.open([event('', { images: [url], local_images: [image, '/outside/synthetic.png'] }), final]);
  assert.equal(page.conversation.messages[0].imageCount, 3);
  assert.equal((await f.read(page, 0, 0)).ok, true);
  assert.equal((await f.read(page, 0, 1)).ok, true);
  assert.equal((await f.read(page, 0, 2)).reason, 'restricted-image');
  const only = input(''); only.payload.content.shift();
  assert.equal((await f.open([only, final])).conversation.messages[0].imageCount, 1);
});
test('native image data never participates in text search; source changes revoke embedded reads', async t => {
  const f = await fixture(t), page = await f.open([input('visible needle'), final]);
  const source = { filePath: f.filePath, canonicalRoot: f.root, mode: 'codex' };
  assert.equal((await f.reader.search(source, 'iVBOR')).totalMatches, 0);
  assert.equal((await f.reader.search(source, 'needle')).totalMatches, 1);
  await fs.appendFile(f.filePath, '\n');
  assert.equal((await f.read(page)).ok, false);
});
test('unsupported, remote and oversized embedded images give bounded explicit failures', async t => {
  const f = await fixture(t);
  for (const [image, reason] of [['https://example.invalid/image.png', 'unsupported-image'],
    ['data:image/png;base64,!!!!', 'unsupported-image'], ['data:image/svg+xml;base64,AAAA', 'unsupported-image'],
    ['data:image/png;base64,' + 'A'.repeat(12 * 1024 ** 2), 'large-image']]) {
    const page = await f.open([input('short prompt', image), final]);
    assert.equal(page.conversation.messages[0].imageCount, 1);
    assert.ok(JSON.stringify(page).length < 4000);
    assert.equal((await f.read(page)).reason, reason);
  }
});
test('image references survive page movement and incremental append without entering renderer payloads', async t => {
  const f = await fixture(t), records = [input('[Image #1]')];
  for (let i = 0; i < 105; i++) records.push(event('prompt ' + i));
  const last = await f.open([...records, final]);
  const first = await f.reader.move(last.page.readerId, 'first');
  assert.equal(first.conversation.messages[0].imageCount, 1);
  assert.equal((await f.read(first)).ok, true);
  await fs.appendFile(f.filePath, JSON.stringify(input('appended image')) + '\n');
  const latest = await f.reader.move(first.page.readerId, 'latest');
  assert.equal(latest.conversation.messages.at(-1).imageCount, 1);
  assert.equal((await f.read(latest, latest.conversation.messages.length - 1)).ok, true);
});
test('multiple image fields, URL objects and missing image data retain independent coordinates', async t => {
  const f = await fixture(t), record = input('[Image #1][Image #2]');
  record.payload.content.push({ type: 'input_image', image_url: { url } }, { type: 'input_image' });
  const page = await f.open([record, final]);
  assert.equal(page.conversation.messages[0].imageCount, 3);
  for (const i of [0, 1]) assert.deepEqual(Buffer.from((await f.read(page, 0, i)).bytes), PNG);
  assert.equal((await f.read(page, 0, 2)).reason, 'unsupported-image');
});
test('very long prompt text with an attachment stays searchable and carries images only on its first part', async t => {
  const f = await fixture(t), page = await f.open([input('x'.repeat(3 * 1024 ** 2) + ' endingneedle'), final]);
  const source = { filePath: f.filePath, canonicalRoot: f.root, mode: 'codex' };
  assert.equal((await f.reader.search(source, 'endingneedle')).totalMatches, 1);
  const first = await f.reader.move(page.page.readerId, 'first');
  assert.equal(first.conversation.messages[0].imageCount, 1);
  assert.equal((await f.read(first)).ok, true);
});
test('a later mirrored response enriches an already displayed prompt after incremental refresh', async t => {
  const f = await fixture(t), first = await f.open([event('[Image #1]')]);
  await fs.appendFile(f.filePath, JSON.stringify(input('[Image #1]')) + '\n' + JSON.stringify(final) + '\n');
  const latest = await f.reader.move(first.page.readerId, 'latest');
  assert.equal(latest.conversation.messages.length, 2);
  assert.equal(latest.conversation.messages[0].imageCount, 1);
  assert.equal((await f.read(latest)).ok, true);
});
test('streaming projection honors duplicate image keys and late block type', async t => {
  const f = await fixture(t);
  const raw = '{"type":"response_item","payload":{"type":"message","role":"user","content":[' +
    '{"type":"input_text","text":"[Image #1]"},{"image_url":"data:image/png;base64,AAAA",' +
    '"image_url":' + JSON.stringify(url) + ',"type":"input_image"}]}}\n';
  await fs.writeFile(f.filePath, raw);
  const page = await f.reader.open({ filePath: f.filePath, canonicalRoot: f.root, mode: 'codex' });
  const ref = f.reader.getImageReference({ readerId: page.page.readerId, page: 1, message: 0, image: 0 });
  const result = await require('../../lib/codex-page-native-image').readEmbeddedImage(ref);
  assert.deepEqual(result.bytes, PNG);
});
test('a large accepted embedded payload is decoded within the worker limit, not inline page memory', async t => {
  const f = await fixture(t), chunk = Buffer.alloc(7 * 1024 ** 2 + 12);
  chunk.writeUInt32BE(chunk.length - 12); chunk.write('tEXt', 4); chunk.write('Comment\0', 8);
  chunk.fill(32, 16, chunk.length - 4);
  chunk.writeUInt32BE(require('node:zlib').crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const bytes = Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
  const page = await f.open([input('small body', 'data:image/png;base64,' + bytes.toString('base64')), final]);
  assert.ok(JSON.stringify(page).length < 4000);
  const result = await f.read(page);
  assert.equal(result.ok, true, result.reason); assert.deepEqual(Buffer.from(result.bytes), bytes);
});
