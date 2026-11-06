'use strict';
const special = /["\\\x00-\x1f]/g;
const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const highSurrogate = code => code >= 0xd800 && code <= 0xdbff;

// Accepts JSON string contents, without the enclosing quotes. Consumers receive
// decoded pieces as they arrive; neither the encoded nor decoded whole string
// is buffered here. Keep surrogate pairs together for correct UTF-8 accounting.
function createJsonStringDecoder(consume) {
  let pending = '', escaped = false, remaining = 0, hex = '';
  const invalid = () => { throw new SyntaxError('Invalid JSON string'); };
  function deliver(text) {
    // Flatten escape-heavy ropes without replacing legal lone UTF-16 surrogates.
    consume(Buffer.from(text, 'utf16le').toString('utf16le'));
  }
  function append(text) {
    pending += text;
    while (pending.length >= 4096) {
      const end = highSurrogate(pending.charCodeAt(4095)) ? 4095 : 4096;
      deliver(pending.slice(0, end)); pending = pending.slice(end);
    }
  }
  return {
    write(text) {
      let i = 0;
      while (i < text.length) {
        const char = text[i];
        if (remaining) {
          if (!/[0-9a-fA-F]/.test(char)) invalid();
          hex += char; remaining--; i++;
          if (!remaining) { append(String.fromCharCode(parseInt(hex, 16))); hex = ''; }
        } else if (escaped) {
          escaped = false; i++;
          if (char === 'u') remaining = 4;
          else if (Object.hasOwn(escapes, char)) append(escapes[char]);
          else invalid();
        } else {
          special.lastIndex = i;
          const match = special.exec(text), end = match ? match.index : text.length;
          if (end > i) append(text.slice(i, end));
          i = end;
          if (i < text.length) {
            if (text[i++] !== '\\') invalid();
            escaped = true;
          }
        }
      }
    },
    finish() {
      if (escaped || remaining) invalid();
      if (pending) deliver(pending);
      pending = '';
    },
  };
}
module.exports = { createJsonStringDecoder };
