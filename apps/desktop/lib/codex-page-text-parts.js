'use strict';
const { splitConversationMessage } = require('./codex-page-message-parts');
const { STRIDE, LOOKBACK } = require('./codex-page-text-boundaries');
function textParts(role, body) {
  if (body.text !== undefined) {
    if (body.bytes <= 512 * 1024) return { total: 1, parts: [{ start: 0, end: body.length, bytes: body.bytes, message: { role, text: body.text } }] };
    const parts = splitConversationMessage({ role, text: body.text });
    return { total: parts.length, parts: parts.map((part, i) => ({ ...part,
      end: parts[i + 1]?.start ?? body.length, bytes: Buffer.byteLength(part.message.text) })) };
  }
  const total = body.bytes <= 512 * 1024 ? 1 : Math.ceil(body.length / STRIDE);
  function* parts() {
    for (let i = 0; i < total; i++) {
      const start = total === 1 ? 0 : i * STRIDE;
      const end = total === 1 ? body.length : Math.min(body.length, start + STRIDE);
      yield { start, end, bytes: total === 1 ? body.bytes : (end - start + LOOKBACK + 1) * 3,
        message: { role, text: '', body, range: { start, end },
          ...(total > 1 ? { continuation: { number: i + 1, total, fenceMarker: 0, startsMidLine: false } } : {}) } };
    }
  }
  return { total, parts: parts() };
}
module.exports = { textParts };
