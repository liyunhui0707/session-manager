'use strict';
const payloadKeys = new Set(['type', 'role', 'phase', 'channel', 'message', 'last_agent_message', 'content']);
function childPath(frame, images = false) {
  if (!frame) return [];
  const p = frame.path, key = frame.kind === 'array' ? '*' : frame.key;
  if (!p) return null;
  if (!p.length && ['type', 'payload'].includes(key)) return [key];
  if (p.length === 1 && p[0] === 'payload' && (payloadKeys.has(key) || images && ['images', 'local_images'].includes(key))) return [...p, key];
  const joined = p.join('.');
  if (joined === 'payload.content' && key === '*') return [...p, key];
  if (joined === 'payload.content.*' && (['type', 'text'].includes(key) || images && key === 'image_url')) return [...p, key];
  if (images && (['payload.images', 'payload.local_images'].includes(joined) && key === '*' ||
      joined === 'payload.content.*.image_url' && key === 'url')) return [...p, key];
  return null;
}
const isImagePath = p => p && ['payload.content.*.image_url', 'payload.content.*.image_url.url',
  'payload.images.*', 'payload.local_images.*'].includes(p.join('.'));
module.exports = { childPath, isImagePath };
