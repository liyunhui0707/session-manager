'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createFastProjection } = require('../../lib/codex-page-fast');
const { createConversationProjection } = require('../../lib/codex-page-projection');
const { textProjection } = require('../../lib/codex-page-text-projection');
function decode(factory, raw) {
  const p = factory(textProjection(7, '中文')), b = Buffer.from(raw);
  try {
    for (let i = 0; i < b.length; i += 97) p.write(b.subarray(i, i + 97));
    return { value: JSON.parse(JSON.stringify(p.finish())), fast: p.fast };
  } catch (e) { return { error: e.code || e.name }; }
}
const samples = [
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '中文🙂 **final**\n```js\n1\n```' }] } }),
  JSON.stringify({ payload: { content: [{ text: 'first', type: 'input_text' }, { type: 'output_text', text: '中文 second' }], role: 'user', type: 'message' }, type: 'response_item' }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '\ud800 lone and \udfff' } }),
  '{"type":"event_msg", "payload":{"type":"user_message","message":"escaped \\u4e2d"}}',
  '{"type":"event_msg","payload":{"type":"user_message","message":"old","message":"new"}}',
  '{"type":"response_item","payload":{"content":[{"type":"input_text","text":"old","text":"new"}]}}',
  JSON.stringify({ type: 'tool', payload: { ignored: '<image>'.repeat(20000) } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'x'.repeat(9000) } }),
  '{"ignored":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}',
  JSON.stringify({ payload: { content: Array(4100).fill(null) } }),
  '{"ignored": [1,]}',
  '\u00a0{"payload":{"message":"invalid whitespace"}}',
  '{"payload":{"content":[{"text":"one","type":"input_text"},{"text":"two","type":"image"},{"text":"three","type":"input_text"}]}}',
];
for (const [i, raw] of samples.entries()) test(`bounded fast projection equals streaming projection: ${i}`, () => {
  const a = decode(createFastProjection, raw), b = decode(createConversationProjection, raw);
  delete a.fast; delete b.fast; assert.deepEqual(a,b);
});
test('canonical small records use fast decoding; duplicate and large records retain streaming decoding', () => {
  assert.equal(decode(createFastProjection,samples[0]).fast,true);
  assert.equal(decode(createFastProjection,samples[4]).fast,false);
  assert.equal(decode(createFastProjection,samples[6]).fast,false);
});
