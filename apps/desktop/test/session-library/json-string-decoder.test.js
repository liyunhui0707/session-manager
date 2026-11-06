'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createJsonStringDecoder } = require('../../lib/codex-page-json-string');

test('streamed JSON string contents agree with JSON.parse at every escape boundary', () => {
  const values = ['中文🙂 / " \\ \b\f\n\r\t', '\ud800', '\udfff', 'a\ud800b\udfff', '',
    'x'.repeat(4095) + '🙂' + 'y'.repeat(4095)];
  for (const value of values) {
    const raw = JSON.stringify(value).slice(1, -1);
    const escaped = Array.from({ length: value.length }, (_, i) => '\\u' + value.charCodeAt(i).toString(16).padStart(4, '0')).join('');
    for (const source of [raw, escaped]) for (const width of [1, 2, 3, 5, 4096, 65536]) {
      const chunks = [], decoder = createJsonStringDecoder(text => chunks.push(text));
      for (let i = 0; i < source.length; i += width) decoder.write(source.slice(i, i + width));
      decoder.finish();
      assert.equal(chunks.join(''), value);
      // Byte accounting must not count one split emoji as two replacement characters.
      assert.equal(chunks.reduce((sum, text) => sum + Buffer.byteLength(text), 0), Buffer.byteLength(value));
      assert.ok(chunks.every(text => text.length <= 4097));
    }
  }
});

test('multi-megabyte escaped text is delivered incrementally in bounded pieces', () => {
  const expected = createHash('sha256'), actual = createHash('sha256');
  let emitted = 0, largest = 0;
  const decoder = createJsonStringDecoder(text => {
    actual.update(text); emitted += text.length; largest = Math.max(largest, text.length);
  });
  const source = '\\u4e2d\\ud83d\\ude42'.repeat(4096), decoded = '中🙂'.repeat(4096);
  for (let i = 0; i < 128; i++) { decoder.write(source); expected.update(decoded); }
  assert.ok(emitted > 1024 * 1024, 'text must reach the consumer before finish');
  decoder.finish();
  assert.equal(actual.digest('hex'), expected.digest('hex'));
  assert.ok(largest <= 4097);
});

test('invalid escapes, raw controls and unterminated escape sequences are rejected', () => {
  for (const raw of ['\\x', '\\u00xy', '\\', '\\u123', 'a\n', 'a"']) {
    const decoder = createJsonStringDecoder(() => {});
    assert.throws(() => { for (const char of raw) decoder.write(char); decoder.finish(); }, SyntaxError);
  }
});

test('consumer limits interrupt decoding immediately', () => {
  const sentinel = new Error('budget exhausted');
  let calls = 0;
  const decoder = createJsonStringDecoder(() => { calls++; throw sentinel; });
  assert.throws(() => decoder.write('x'.repeat(65536)), error => error === sentinel);
  assert.equal(calls, 1);
});
