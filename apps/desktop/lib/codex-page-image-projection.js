'use strict';
const { childPath } = require('./codex-page-projection-path');
// Index only: no encoded pixels enter the page/seek/search cache.
function imageProjection(record) {
  let field = 0;
  return frames => {
    const index = field++, local = childPath(frames.at(-1), true)?.join('.') === 'payload.local_images.*';
    let head = '', length = 0;
    return {
      write(text) { length += text.length; if (index < 16) head = (head + text.slice(0, 4096 - head.length)).slice(0, 4096); },
      finish() {
        if (index >= 16) return null;
        if (local) return length <= 4096 ? { kind: 'local', path: head } : { kind: 'unavailable', reason: 'restricted-image' };
        if (/^data:image\/(?:png|jpeg);base64,/.test(head)) return { kind: 'embedded', record, field: index, length };
        return { kind: 'unavailable', reason: 'unsupported-image' };
      },
    };
  };
}
const isImage = value => value && ['local', 'embedded', 'unavailable'].includes(value.kind);
function contentImages(content) {
  return content.filter(b => b?.type === 'input_image').slice(0, 16).map(b => {
    const image = b.image_url?.url || b.image_url;
    return isImage(image) ? image : { kind: 'unavailable', reason: 'unsupported-image' };
  });
}
function eventImages(payload) {
  return [payload.images, payload.local_images].flatMap(a => Array.isArray(a) ? a.filter(isImage) : []).slice(0, 16);
}
function mergeImages(a, b) {
  const rank = image => ({ embedded: 3, local: 2, unavailable: 1 })[image?.kind] || 0;
  const left = a.images || [], right = b.images || [];
  if (!left.length && !right.length) return b;
  return { ...b, images: Array.from({ length: Math.max(left.length, right.length) }, (_, i) =>
    rank(left[i]) > rank(right[i]) ? left[i] : right[i]) };
}
module.exports = { imageProjection, contentImages, eventImages, mergeImages };
