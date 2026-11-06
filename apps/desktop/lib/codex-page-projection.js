'use strict';
const { StringDecoder } = require('node:string_decoder');
const { createJsonStringDecoder } = require('./codex-page-json-string');
const MAX_RETAINED = 2 * 1024 * 1024;
const payloadKeys = new Set(['type', 'role', 'phase', 'channel', 'message', 'last_agent_message', 'content']);
const special = /["\\\x00-\x1f]/g;
const space = char => char === ' ' || char === '\n' || char === '\r' || char === '\t';
const failure = code => Object.assign(new Error(code), { code });

// A bounded streaming JSON projection, not a repair parser. All structure and
// string escapes (including ignored data) are validated. Only fields needed by
// the turn policy are retained; key order never decides whether text is kept.
function createConversationProjection(options = {}) {
  const decoder = new StringDecoder('utf8'), stack = [];
  let rootState = 'value', result, token = null, retainedBytes = 0;
  const invalid = () => { throw new SyntaxError('Invalid JSON record'); };
  function childPath(frame) {
    if (!frame) return [];
    const path = frame.path;
    if (!path) return null;
    const key = frame.kind === 'array' ? '*' : frame.key;
    if (path.length === 0 && ['type', 'payload'].includes(key)) return [key];
    if (path.length === 1 && path[0] === 'payload' && payloadKeys.has(key)) return [...path, key];
    if (path.join('.') === 'payload.content' && key === '*') return [...path, key];
    if (path.join('.') === 'payload.content.*' && ['type', 'text'].includes(key)) return [...path, key];
    return null;
  }
  function expectsValue() {
    const frame = stack.at(-1);
    return frame ? ['value', 'valueOrEnd'].includes(frame.state) : rootState === 'value';
  }
  function add(value) {
    const frame = stack.at(-1);
    if (!expectsValue()) invalid();
    if (!frame) { result = value; rootState = 'done'; return; }
    if (frame.value !== undefined) {
      if (frame.kind === 'array') {
        if (frame.value.length >= 4096) throw failure('JSON_LIMIT');
        frame.value.push(value === undefined ? null : value);
      } else if (childPath(frame)) frame.value[frame.key] = value;
    }
    frame.state = 'commaOrEnd'; frame.key = null;
  }
  function begin(kind) {
    if (!expectsValue()) invalid();
    if (stack.length >= 128) throw failure('JSON_LIMIT');
    const path = childPath(stack.at(-1));
    stack.push({ kind, path, value: path ? (kind === 'array' ? [] : Object.create(null)) : undefined,
      state: kind === 'array' ? 'valueOrEnd' : 'keyOrEnd', key: null });
  }
  function end(kind) {
    const frame = stack.at(-1);
    if (!frame || frame.kind !== kind || !['commaOrEnd', kind === 'array' ? 'valueOrEnd' : 'keyOrEnd'].includes(frame.state)) invalid();
    options.finishContainer?.(frame);
    stack.pop(); add(frame.value);
  }
  function append(text) {
    if (!token.keep) return;
    if (token.textDecoder) { token.textDecoder.write(text); return; }
    token.length += text.length;
    if (token.length > token.limit) {
      if (token.key) { token.keep = false; token.parts = []; token.pending = ''; return; }
      throw failure('JSON_LIMIT');
    }
    token.pending += text;
    // Flatten bounded fragments: millions of escaped characters must not retain
    // millions of concatenation rope nodes until the final JSON.parse call.
    if (token.pending.length >= 4096) {
      token.parts.push(Buffer.from(token.pending).toString('utf8')); token.pending = '';
    }
  }
  function stringStart() {
    const frame = stack.at(-1);
    const key = frame?.kind === 'object' && ['key', 'keyOrEnd'].includes(frame.state);
    if (!key && !expectsValue()) invalid();
    const path = key ? null : childPath(frame);
    const isText = path && ['text', 'message', 'last_agent_message'].includes(path.at(-1));
    token = { kind: 'string', key, keep: key || !!path, isText, parts: [], pending: '', length: 0,
      limit: 8192, escaped: false, unicode: 0 };
    if (isText) {
      token.textSink = options.createText?.(stack);
      token.textDecoder = createJsonStringDecoder(text => {
        if (token.textSink) { token.textSink.write(text); return; }
        retainedBytes += Buffer.byteLength(text);
        if (retainedBytes > MAX_RETAINED) throw failure('MESSAGE_TOO_LARGE');
        token.parts.push(text);
      });
    } else append('"');
  }
  function stringEnd() {
    let value;
    if (token.keep) {
      if (token.textDecoder) {
        token.textDecoder.finish(); value = token.textSink ? token.textSink.finish() : token.parts.join('');
      } else value = JSON.parse(token.parts.join('') + token.pending);
      if (!token.key && !token.textDecoder) {
        retainedBytes += Buffer.byteLength(value);
        if (retainedBytes > MAX_RETAINED) throw failure('MESSAGE_TOO_LARGE');
      }
    }
    if (token.key) { const frame = stack.at(-1); frame.key = value; frame.state = 'colon'; }
    else add(value);
    token = null;
  }
  function atomEnd() {
    let value;
    // JSON.parse handles exact number/literal grammar, without eval. Numeric
    // lexemes have a small independent bound so ignored numbers cannot grow RAM.
    try { value = JSON.parse(token.text); } catch { invalid(); }
    if (typeof value === 'object' && value !== null) invalid();
    add(token.keep ? value : undefined); token = null;
  }
  function feed(text) {
    let i = 0;
    while (i < text.length) {
      const char = text[i];
      if (token?.kind === 'string') {
        if (token.unicode) {
          if (!/[0-9a-fA-F]/.test(char)) invalid();
          append(char); token.unicode--; i++; continue;
        }
        if (token.escaped) {
          if (!'"\\/bfnrtu'.includes(char)) invalid();
          append(char); token.escaped = false; if (char === 'u') token.unicode = 4;
          i++; continue;
        }
        // Fast-skip base64 and ordinary text, retaining no ignored string bytes.
        special.lastIndex = i;
        const match = special.exec(text), until = match ? match.index : text.length;
        if (until > i) { append(text.slice(i, until)); i = until; }
        if (i === text.length) continue;
        const mark = text[i++];
        if (mark === '"') { if (!token.textDecoder) append(mark); stringEnd(); }
        else if (mark === '\\') { append(mark); token.escaped = true; }
        else invalid();
        continue;
      }
      if (token?.kind === 'atom') {
        if (space(char) || ',]}:'.includes(char)) { atomEnd(); continue; }
        token.text += char;
        if (token.text.length > 1024) throw failure('JSON_LIMIT');
        i++; continue;
      }
      if (space(char)) { i++; continue; }
      const frame = stack.at(-1);
      if (char === '"') stringStart();
      else if (char === '{') begin('object');
      else if (char === '[') begin('array');
      else if (char === '}') end('object');
      else if (char === ']') end('array');
      else if (char === ':') {
        if (frame?.kind !== 'object' || frame.state !== 'colon') invalid();
        frame.state = 'value';
      } else if (char === ',') {
        if (!frame || frame.state !== 'commaOrEnd') invalid();
        frame.state = frame.kind === 'object' ? 'key' : 'value';
      } else if ('-0123456789tfn'.includes(char)) {
        if (!expectsValue()) invalid();
        token = { kind: 'atom', text: char, keep: !!childPath(frame) };
      } else invalid();
      i++;
    }
  }
  return {
    write(buffer) { feed(decoder.write(buffer)); },
    finish() {
      feed(decoder.end());
      if (token?.kind === 'atom') atomEnd();
      if (token || stack.length || rootState !== 'done') invalid();
      return result;
    },
    get retainedBytes() { return retainedBytes; },
  };
}
module.exports = { createConversationProjection };
