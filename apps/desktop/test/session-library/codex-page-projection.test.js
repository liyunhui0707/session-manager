'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => require('../../lib/codex-page-projection');
function read(text, chunk = 7) {
  const reader = load().createConversationProjection();
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += chunk) reader.write(bytes.subarray(i, i + chunk));
  return reader.finish();
}
test('projects conversation fields in any key order while validating ignored JSON', () => {
  const record = { unrelated: { nested: ['hello', true, null, 1.25e-2] }, payload: {
    content: [{ image_url: 'data:image/png;base64,' + 'x'.repeat(9 * 1024 ** 2), type: 'input_image' },
      { text: '你好 👩🏽‍💻\\"\nend', type: 'input_text' }], role: 'user', type: 'message' }, type: 'response_item' };
  const result = read(JSON.stringify(record), 65536);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { payload: { content: [{ type: 'input_image' },
    { text: '你好 👩🏽‍💻\\"\nend', type: 'input_text' }], role: 'user', type: 'message' }, type: 'response_item' });
});
test('large tool strings do not consume the retained projection budget', () => {
  const reader = load().createConversationProjection();
  reader.write(Buffer.from('{"type":"response_item","payload":{"type":"function_call_output","output":"'));
  const chunk = Buffer.from('x'.repeat(65536));
  for (let i = 0; i < 1024; i++) reader.write(chunk);
  reader.write(Buffer.from('"}}\n'));
  assert.equal(reader.finish().payload.type, 'function_call_output');
  assert.ok(reader.retainedBytes < 1024);
});
test('escaped keys, duplicate keys and prototype-looking fields match JSON semantics', () => {
  const result = read('{"type":"wrong","type":"event_msg","payl\\u006fad":{"type":"user_message","message":"old","message":"new","__proto__":{"message":"bad"}}}', 1);
  assert.equal(result.type, 'event_msg'); assert.equal(result.payload.message, 'new');
  assert.equal({}.message, undefined);
  assert.equal(read('{"payload":{"type":"user_message","message":"old"},"payload":null}').payload, null);
});
for (const text of ['{"payload":{"ignored":"\\x"}}', '{"a":[1,]}', '{"a":true,}', '{"a":01}',
  '{"a":1e+}', '{"a":trux}', '{"a":"\u0001"}', '{"a":{]', '{}{}', '{"a":"\\u00xy"}',
  '{"a":"unfinished', '{"a":1', '', '{"a":1 "b":2}', '{"a":[,1]}']) {
  test(`reject malformed JSON even outside projected fields: ${JSON.stringify(text)}`, () => assert.throws(() => read(text, 1), SyntaxError));
}
test('excessive nesting and retained text report resource limits, not valid empty messages', () => {
  assert.throws(() => read('['.repeat(200) + ']'.repeat(200)), { code: 'JSON_LIMIT' });
  assert.throws(() => read(JSON.stringify({ payload: { type: 'user_message', message: 'x'.repeat(4 * 1024 ** 2) } }), 65536), { code: 'MESSAGE_TOO_LARGE' });
});
test('decoded text budget is enforced while reading, before the closing quote arrives', () => {
  const reader = load().createConversationProjection();
  reader.write(Buffer.from('{"payload":{"message":"'));
  // Raw encoding is below the old 12 MiB lexeme cap, but decoded UTF-8 is over 2 MiB.
  const chunk = Buffer.from('\\u4e2d'.repeat(4096));
  assert.throws(() => { for (let i = 0; i < 180; i++) reader.write(chunk); }, { code: 'MESSAGE_TOO_LARGE' });
});
test('decoded budget counts surrogate pairs once across projected string chunks', () => {
  const text = 'x'.repeat(4095) + '🙂' + '中'.repeat(1024);
  const reader = load().createConversationProjection();
  const raw = '{"payload":{"message":' + JSON.stringify(text) + '}}';
  for (const byte of Buffer.from(raw)) reader.write(Buffer.from([byte]));
  assert.equal(reader.finish().payload.message, text);
  assert.equal(reader.retainedBytes, Buffer.byteLength(text));
});
test('ordinary records project exactly the supported scalar and text-block fields across chunk boundaries', () => {
  const records = [
    { type: 'event_msg', payload: { type: 'user_message', message: '路径 /tmp/示例，emoji 🚀\n下一行' } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Final \t **reply**' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', channel: 'final', content: [{ type: 'output_text', text: '\\ \" \b \f \r' }] } },
  ];
  for (const record of records) for (const chunk of [1, 2, 3, 16, 4096]) {
    assert.deepEqual(JSON.parse(JSON.stringify(read(JSON.stringify(record), chunk))), record);
  }
});
test('bounded generated JSON and single-character mutations agree with JSON.parse syntax', () => {
  let seed = 92341;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const value = depth => {
    const pick = next(depth ? 6 : 4);
    if (pick === 0) return null;
    if (pick === 1) return !!next(2);
    if (pick === 2) return (next(20000) - 10000) / 7;
    if (pick === 3) return ['"\\\n\t', '汉字🙂', '', 'null', '\u0000'][next(5)];
    if (pick === 4) return [value(depth - 1), value(depth - 1)];
    return { type: value(depth - 1), payload: value(depth - 1), ignored: value(depth - 1) };
  };
  for (let i = 0; i < 500; i++) {
    const text = JSON.stringify(value(4)), at = next(text.length + 1);
    const candidates = [text, text.slice(0, at) + ['"', ',', ':', '\\', '[', '}', '0'][next(7)] + text.slice(at)];
    for (const candidate of candidates) {
      let valid = true;
      try { JSON.parse(candidate); } catch { valid = false; }
      if (valid) assert.doesNotThrow(() => read(candidate, 1 + next(11)));
      else assert.throws(() => read(candidate, 1 + next(11)), SyntaxError);
    }
  }
});
