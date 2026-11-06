'use strict';
const { describeMessage } = require('./session-viewer/conversation-presentation');
const PART_BYTES = 256 * 1024;
// Only presentation is segmented. Original text is retained intact by the turn
// reducer until completion/mirror selection, then searched before splitting.
function splitConversationMessage(message) {
  const text = message.text, bytes = Buffer.from(text);
  if (bytes.length <= 512 * 1024 || describeMessage(text, message.role)) return [{ message, start: 0 }];
  const parts = [];
  let byteStart = 0, start = 0, lineStart = 0, fenceMarker = 0;
  function advanceFence(until) {
    while (lineStart < until) {
      const end = text.indexOf('\n', lineStart);
      if (end < 0 || end >= until) break;
      const line = text.slice(lineStart, end).replace(/\r$/, '');
      const run = line.match(/^`{3,}/)?.[0].length || 0;
      if (fenceMarker) {
        if (run >= fenceMarker && !line.slice(run).trim()) fenceMarker = 0;
      } else if (run) fenceMarker = run;
      lineStart = end + 1;
    }
  }
  while (byteStart < bytes.length) {
    let end = Math.min(byteStart + PART_BYTES, bytes.length);
    if (end < bytes.length) {
      const paragraph = bytes.lastIndexOf('\n\n', end - 2), line = bytes.lastIndexOf(10, end - 1);
      if (paragraph >= byteStart + PART_BYTES / 2) end = paragraph + 2;
      else if (line >= byteStart + PART_BYTES / 2) end = line + 1;
      // Do not split a multi-byte UTF-8 code point.
      while (end > byteStart && (bytes[end] & 0xc0) === 0x80) end--;
    }
    advanceFence(start);
    const width = bytes.subarray(byteStart, end).toString('utf8').length;
    const piece = text.slice(start, start + width); // Preserve literal unpaired UTF-16 units too.
    parts.push({ start, message: { role: message.role, text: piece,
      continuation: { number: parts.length + 1, fenceMarker,
        startsMidLine: start > 0 && text[start - 1] !== '\n' } } });
    start += piece.length; byteStart = end;
  }
  for (const part of parts) part.message.continuation.total = parts.length;
  return parts;
}
module.exports = { splitConversationMessage, PART_BYTES };
