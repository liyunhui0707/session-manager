'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => require('../../lib/session-viewer/local-image-preview');
function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(b);
  b.writeUInt32BE(13,8); b.write('IHDR',12); b.writeUInt32BE(width,16); b.writeUInt32BE(height,20);
  b[24] = 8; b[25] = 6;
  return new Uint8Array(b);
}
test('preview accepts bounded PNG/JPEG dimensions from bytes, not file extensions', () => {
  const { inspectLocalImage } = load();
  assert.deepEqual(inspectLocalImage(png(320,240)), { mime: 'image/png', width: 320, height: 240 });
  const jpeg = new Uint8Array([255,216,255,192,0,17,8,0,240,1,64,3,1,17,0,2,17,0,3,17,0]);
  assert.deepEqual(inspectLocalImage(jpeg), { mime: 'image/jpeg', width: 320, height: 240 });
});
test('preview rejects huge dimensions, empty images, oversized bytes, SVG and truncated JPEG', () => {
  const { inspectLocalImage, MAX_IMAGE_BYTES } = load();
  for (const bytes of [png(100000,100000), png(0,10), new Uint8Array(MAX_IMAGE_BYTES + 1),
    new TextEncoder().encode('<svg onload="attack()"></svg>'), new Uint8Array([255,216,255,192,0,17])]) {
    assert.throws(() => inspectLocalImage(bytes));
  }
});
test('animated PNG is rejected before browser decoding', () => {
  const { inspectLocalImage } = load();
  const animated = new Uint8Array(53); animated.set(png(320,240));
  const view = new DataView(animated.buffer); view.setUint32(33,8); view.setUint32(37,0x6163544c);
  assert.throws(() => inspectLocalImage(animated));
});

function previewHarness() {
  const { makeFakeDocument } = require('./read-fake-document');
  const doc = makeFakeDocument(), create = doc.createElement, observers = [], urls = new Set();
  let sequence = 0;
  doc.createElement = tag => {
    const el = create(tag), handlers = {};
    Object.assign(el, { isConnected: true, style: {},
      remove() { if (el.parent) el.parent.removeChild(el); },
      append(...children) { children.forEach(child => el.appendChild(child)); },
      replaceChildren() { el.children.length = 0; },
      addEventListener(name, fn) { handlers[name] = fn; },
      click() { return handlers.click?.(); }, focus() {},
    });
    return el;
  };
  doc.defaultView = { Blob,
    URL: { createObjectURL() { const url = 'blob:' + sequence++; urls.add(url); return url; }, revokeObjectURL: url => urls.delete(url) },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() { this.closed = true; }
      visible(value = true) { this.callback([{ isIntersecting: value }]); }
    },
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { doc, observers, urls, tick, card: () => doc.createElement('div') };
}
test('automatic previews load lazily, cap retained images and release on source changes', async () => {
  const { attachLocalImagePicker, closeLocalImagePreview } = load(), h = previewHarness();
  let reads = 0;
  for (let i = 0; i < 6; i++) attachLocalImagePicker(h.card(), h.doc, 'Image', async () => {
    reads++; return { ok: true, bytes: png(10,10), mime: 'image/png', width: 10, height: 10 };
  });
  assert.equal(reads, 0);
  for (const observer of h.observers) { observer.visible(); await h.tick(); }
  assert.equal(reads, 6); assert.equal(h.urls.size, 4);
  h.observers.at(-1).visible(false); assert.equal(h.urls.size, 3);
  h.observers.at(-1).visible(); await h.tick(); assert.equal(h.urls.size, 4); assert.equal(reads, 7);
  closeLocalImagePreview(h.doc);
  assert.equal(h.urls.size, 0); assert.ok(h.observers.every(o => o.closed));
});
test('late image results cannot recreate a preview after leaving the conversation', async () => {
  const { attachLocalImagePicker, closeLocalImagePreview } = load(), h = previewHarness();
  let finish;
  attachLocalImagePicker(h.card(), h.doc, 'Image', () => new Promise(resolve => { finish = resolve; }));
  h.observers[0].visible(); await h.tick(); closeLocalImagePreview(h.doc);
  finish({ ok: true, bytes: png(10,10), mime: 'image/png', width: 10, height: 10 });
  await h.tick(); assert.equal(h.urls.size, 0);
});

test('5K screenshots fit the bounded preview policy; pixel excess has a distinct reason', () => {
  const { inspectLocalImage } = load();
  assert.deepEqual(inspectLocalImage(png(5120,2820)), { mime: 'image/png', width: 5120, height: 2820 });
  assert.throws(() => inspectLocalImage(png(7000,4000)), { reason: 'pixel-limit' });
});

const result = () => ({ ok: true, bytes: png(800,540), mime: 'image/png', width: 800, height: 540 });
const previewOf = card => card.children.find(n => n.className === 'attachment-preview');
test('explicit close survives viewport reentry until the user loads the image again', async () => {
  const { attachLocalImagePicker, closeLocalImagePreview } = load(), h = previewHarness(), card = h.card();
  let reads = 0;
  attachLocalImagePicker(card, h.doc, 'Image', async () => { reads++; return result(); });
  h.observers[0].visible(); await h.tick();
  previewOf(card).children.find(n => n.className === 'attachment-close').click();
  for (let i = 0; i < 3; i++) { h.observers[0].visible(false); h.observers[0].visible(); await h.tick(); }
  assert.equal(reads, 1); assert.equal(h.urls.size, 0); assert.equal(previewOf(card).children.length, 0);
  await card.children.find(n => n.textContent === '加载图片').click();
  assert.equal(reads, 2); assert.equal(h.urls.size, 1);
  closeLocalImagePreview(h.doc);
});
test('offscreen release retains responsive image space and controls while revoking pixels', async () => {
  const { attachLocalImagePicker, closeLocalImagePreview } = load(), h = previewHarness(), card = h.card();
  attachLocalImagePicker(card, h.doc, 'Image', async () => result());
  h.observers[0].visible(); await h.tick();
  const preview = previewOf(card), slot = preview.children[0], status = card.children.find(n => n.className === 'attachment-note');
  const note = status.textContent;
  assert.equal(slot.className, 'attachment-image-slot');
  assert.equal(slot.style.aspectRatio, '800 / 540');
  h.observers[0].visible(false);
  assert.equal(h.urls.size, 0); assert.equal(slot.children.length, 0);
  assert.equal(preview.children[0], slot); assert.equal(preview.children.length, 3);
  assert.equal(status.textContent, note);
  h.observers[0].visible(); await h.tick();
  assert.equal(h.urls.size, 1); assert.equal(preview.children[0].style.aspectRatio, '800 / 540');
  closeLocalImagePreview(h.doc);
});
test('leaving while a thumbnail loads cancels its late render without consuming a lease', async () => {
  const { attachLocalImagePicker, closeLocalImagePreview } = load(), h = previewHarness(), card = h.card();
  let finish;
  attachLocalImagePicker(card, h.doc, 'Image', () => new Promise(resolve => { finish = resolve; }));
  h.observers[0].visible(); await h.tick(); h.observers[0].visible(false);
  finish(result()); await h.tick();
  assert.equal(h.urls.size, 0); assert.equal(previewOf(card).children.length, 0);
  closeLocalImagePreview(h.doc);
});
test('lease eviction keeps layout and still lets the user close an evicted preview', async () => {
  const { attachLocalImagePicker, closeLocalImagePreview } = load(), h = previewHarness();
  const cards = Array.from({length: 5}, () => h.card());
  for (const card of cards) attachLocalImagePicker(card, h.doc, 'Image', async () => result());
  for (const observer of h.observers) { observer.visible(); await h.tick(); }
  assert.equal(h.urls.size, 4); assert.equal(previewOf(cards[0]).children.length, 3);
  previewOf(cards[0]).children.find(n => n.className === 'attachment-close').click();
  h.observers[0].visible(false); h.observers[0].visible(); await h.tick();
  assert.equal(previewOf(cards[0]).children.length, 0); assert.equal(h.urls.size, 4);
  closeLocalImagePreview(h.doc);
});

test('thumbnail space uses its actual pixels while status retains original dimensions', async () => {
  const { attachLocalImagePicker, closeLocalImagePreview } = load(), h = previewHarness(), card = h.card();
  attachLocalImagePicker(card, h.doc, 'Image', async () => ({ ok: true, bytes: png(800,441),
    mime: 'image/png', width: 5120, height: 2820 }));
  h.observers[0].visible(); await h.tick();
  assert.equal(previewOf(card).children[0].style.aspectRatio, '800 / 441');
  assert.match(card.children.find(n => n.className === 'attachment-note').textContent, /5120 × 2820/);
  closeLocalImagePreview(h.doc);
});
