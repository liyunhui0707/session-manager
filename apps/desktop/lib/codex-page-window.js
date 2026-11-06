'use strict';
const CACHE_BYTES = 8 * 1024 * 1024;
// Private, memory-only neighboring pages. This is a retained payload budget,
// not a claim about the process heap or V8's transient allocation overhead.
function createPageWindow(target) {
  let pages = [], bytes = 0;
  return {
    add(number, messages) {
      if (target !== undefined && Math.abs(number - target) > 1) return;
      // Descriptors have little JSON but materialize into text. Reserve a
      // conservative UTF-8 allowance including boundary lookback/escaping.
      const size = Buffer.byteLength(JSON.stringify(messages)) + messages.reduce((sum, m) =>
        sum + (m.body ? (m.range.end - m.range.start + 4096) * 6 : 0), 0);
      if (size > CACHE_BYTES) return;
      pages.push({ number, messages, size }); bytes += size;
      while (pages.length > 3 || bytes > CACHE_BYTES) bytes -= pages.shift().size;
    },
    entries: () => pages.map(({ number, messages }) => ({ number, messages })),
  };
}
module.exports = { createPageWindow, CACHE_BYTES };
