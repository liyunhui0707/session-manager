'use strict';
const { createZstdSession } = require('./codex-page-zstd-stream');
const { LOOKBACK, boundary } = require('./codex-page-text-boundaries');
const failure = () => Object.assign(new Error('SOURCE_CHANGED'), { code: 'SOURCE_CHANGED' });

// Track fence context without retaining arbitrarily long source lines.
class FenceState {
  constructor() { this.marker = 0; this.ticks = 0; this.rest = false; this.nonspace = false; this.midline = false; }
  write(text) {
    for (const char of text) {
      if (char === '\n') {
        if (this.marker) { if (this.ticks >= this.marker && !this.nonspace) this.marker = 0; }
        else if (this.ticks >= 3) this.marker = this.ticks;
        this.ticks = 0; this.rest = this.nonspace = this.midline = false;
      } else {
        this.midline = true;
        if (!this.rest && char === '`') this.ticks++;
        else { this.rest = true; if (char.trim()) this.nonspace = true; }
      }
    }
  }
}
function captureBody(body, range) {
  const base = Math.max(0, range.start - LOOKBACK), limit = Math.min(body.length, range.end + 1);
  const fence = new FenceState(), pieces = [];
  let position = 0, refIndex = -1;
  function write(text) {
    if (position < base) fence.write(text.slice(0, Math.min(text.length, base - position)));
    const start = Math.max(0, base - position), end = Math.min(text.length, limit - position);
    if (end > start) pieces.push(text.slice(start, end));
    position += text.length;
  }
  return {
    begin(index) {
      for (let i = refIndex + 1; i < index; i++) {
        if (body.refs[i].literal === undefined) throw failure();
        write(body.refs[i].literal);
      }
      refIndex = index;
    },
    write,
    finish() {
      if (position !== body.length) throw failure();
      const captured = pieces.join('');
      const start = range.start ? boundary(captured, range.start, base) - base : 0;
      const end = range.end === body.length ? body.length - base : boundary(captured, range.end, base) - base;
      fence.write(captured.slice(0, start));
      return { text: captured.slice(start, end), fenceMarker: fence.marker, startsMidLine: fence.midline };
    },
  };
}

async function materialize(source, snapshot, messages) {
  const pending = messages.filter(message => message.body);
  if (!pending.length) return messages;
  const fields = new Map(), captures = [];
  for (const message of pending) {
    const capture = captureBody(message.body, message.range);
    captures.push({ capture, message });
    message.body.refs.forEach((ref, index) => {
      if (ref.literal !== undefined) return;
      if (!fields.has(ref.id)) fields.set(ref.id, []);
      fields.get(ref.id).push({ capture, index });
    });
  }
  const stream = await createZstdSession({ ...source, snapshot }, {
    allowPlain: true, projectConversation: true,
    projectionOptions: record => {
      let field = 0;
      return { createText() {
        const destinations = fields.get(`${record}:${field++}`) || [];
        for (const { capture, index } of destinations) capture.begin(index);
        return { write(text) { for (const { capture } of destinations) capture.write(text); }, finish() {} };
      } };
    },
  });
  try {
    // Validate to EOF even after finding the page: corruption or a changed source
    // must not publish a page from a different snapshot.
    for await (const record of stream.rawRecords()) { void record; }
    for (const { capture, message } of captures) {
      const result = capture.finish();
      message.text = result.text;
      if (message.continuation) Object.assign(message.continuation,
        { fenceMarker: result.fenceMarker, startsMidLine: result.startsMidLine });
      delete message.body; delete message.range;
    }
    return messages;
  } finally { await stream.close(); }
}
module.exports = { materialize };
