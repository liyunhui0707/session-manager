'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createConversationReader } = require('../../lib/codex-page-reader-v2');
const { registerConversationImages } = require('../../lib/codex-page-images');
const { createSessionSourceState } = require('../../lib/session-source-state');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7s8AAAAASUVORK5CYII=', 'base64');
async function fixture(t, thumbnail) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-image-test-')));
  const root = path.join(base, '.source'), temp = path.join(base, 'clipboard');
  await fs.mkdir(root); await fs.mkdir(temp);
  const filePath = path.join(root, 'rollout-test.jsonl');
  const reader = createConversationReader(), state = createSessionSourceState(event => event === 'trusted');
  const handlers = new Map();
  const guarded = state.guard({ handle: (name, fn) => handlers.set(name, fn) });
  guarded.handle('test:switch', () => { state.useLibrary(); return { ok: true }; });
  let transforms = 0;
  registerConversationImages(guarded, {
    reader, sourceState: state, tempRoot: temp,
    thumbnail: async bytes => { transforms++; return thumbnail ? thumbnail(bytes) : bytes; },
  });
  t.after(async () => { await reader.close(); await fs.rm(base, { recursive: true, force: true }); });
  async function open(imagePath) {
    const text = `<image name=[Image #1] path="${imagePath}"></image>\nLook at this image.`;
    await fs.writeFile(filePath, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n');
    const session = await reader.open({ filePath, canonicalRoot: root, mode: 'codex' }); state.useCodex(filePath);
    return { readerId: session.page.readerId, page: session.page.number, message: 0, image: 0, size: 'preview' };
  }
  const read = (request, event = 'trusted') => handlers.get('codexImage:read')(event, request);
  return { root, temp, filePath, reader, state, open, read, transforms: () => transforms,
    switchSource: () => handlers.get('test:switch')('trusted') };
}
test('referenced PNGs load through main-owned coordinates, preserving bytes and refusing renderer paths', async t => {
  const f = await fixture(t), image = path.join(f.root, 'drawing.png'); await fs.writeFile(image, PNG);
  const request = await f.open(image), result = await f.read(request);
  assert.equal(result.ok, true); assert.equal(result.width, 1); assert.equal(result.mime, 'image/png');
  assert.deepEqual(Buffer.from(result.bytes), PNG); assert.equal(f.transforms(), 1);
  assert.equal((await f.read({ ...request, size: 'original' })).ok, true); assert.equal(f.transforms(), 1);
  assert.deepEqual(await fs.readFile(image), PNG);
  for (const bad of [{ ...request, path: image }, { ...request, message: 1 }, { ...request, image: -1 }, { ...request, size: 'file' }])
    assert.equal((await f.read(bad)).ok, false);
  assert.equal((await f.read(request, 'untrusted')).reason, 'invalid-request');
  f.state.useLibrary(); assert.equal((await f.read(request)).reason, 'stale-image');
});
test('missing, outside, network, symlink and invalid images return useful path-free states', async t => {
  const f = await fixture(t);
  assert.equal((await f.read(await f.open(path.join(f.root, 'missing.png')))).reason, 'missing-image');
  for (const image of ['/outside/image.png', 'https://example.invalid/image.png', path.join(f.root, '../escape.png')]) {
    const result = await f.read(await f.open(image)); assert.equal(result.reason, 'restricted-image');
    assert.ok(!JSON.stringify(result).includes(image));
  }
  const image = path.join(f.root, 'invalid.png'); await fs.writeFile(image, '<svg/>');
  assert.equal((await f.read(await f.open(image))).reason, 'unsupported-image');
  const link = path.join(f.root, 'link.png'); await fs.symlink(image, link);
  assert.equal((await f.read(await f.open(link))).reason, 'restricted-image');
  for (const excluded of ['.hidden', 'secrets']) {
    assert.equal((await f.read(await f.open(path.join(f.root, excluded, 'image.png')))).reason, 'restricted-image');
  }
  const directoryLink = path.join(f.root, 'linked-directory'); await fs.symlink(f.temp, directoryLink);
  assert.equal((await f.read(await f.open(path.join(directoryLink, 'image.png')))).reason, 'restricted-image');
});
test('an old reader coordinate is revoked after opening a new conversation', async t => {
  const f = await fixture(t), image = path.join(f.root, 'drawing.png'); await fs.writeFile(image, PNG);
  const old = await f.open(image); await f.open(image);
  assert.equal((await f.read(old)).reason, 'stale-image');
});
test('outside the source, only direct Codex clipboard images in the known temporary root are eligible', async t => {
  const f = await fixture(t);
  for (const name of ['codex-clipboard-test.png', 'unrelated.png']) {
    const image = path.join(f.temp, name); await fs.writeFile(image, PNG);
    const result = await f.read(await f.open(image));
    assert.equal(result.ok, name.startsWith('codex-clipboard-'));
  }
  const link = path.join(f.temp, 'codex-clipboard-link.png'); await fs.symlink(path.join(f.temp, 'codex-clipboard-test.png'), link);
  assert.equal((await f.read(await f.open(link))).reason, 'restricted-image');
});
test('image allocation limits and page coordinates are enforced before publication', async t => {
  const f = await fixture(t), image = path.join(f.root, 'large.png');
  await fs.writeFile(image, Buffer.alloc(8 * 1024 ** 2 + 1));
  assert.equal((await f.read(await f.open(image))).reason, 'large-image');
  const bad = Buffer.from(PNG); bad.writeUInt32BE(20000, 16); await fs.writeFile(image, bad);
  assert.equal((await f.read(await f.open(image))).reason, 'pixel-limit');
  await fs.writeFile(image, PNG); const request = await f.open(image);
  assert.equal((await f.read({ ...request, page: 2 })).reason, 'stale-image');
});
test('an in-flight thumbnail cannot block source navigation or publish after that navigation', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, bytes => new Promise(resolve => { finish = () => resolve(bytes); started(); }));
  const image = path.join(f.root, 'drawing.png'); await fs.writeFile(image, PNG);
  const request = await f.open(image), loading = f.read(request); await ready;
  assert.equal((await f.read(request)).reason, 'in-progress', 'at most one main-process image decode');
  const switched = await f.switchSource(); finish(); const result = await loading;
  assert.equal(switched.ok, true, 'image loading must not lock navigation');
  assert.equal(result.reason, 'stale-image');
});
