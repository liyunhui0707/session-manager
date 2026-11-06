'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationProjection } = require('../../lib/codex-page-projection');
const { textProjection, textPolicy } = require('../../lib/codex-page-text-projection');
const { createTurnReader } = require('../../lib/codex-page-turns');

test('descriptor turn decisions agree with the string reducer over generated event sequences', () => {
  let seed = 733;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const texts = ['', 'hello', '中文🙂', '\ud800', '\n\nhello', '<INSTRUCTIONS>setup', 'Repeat'];
  for (let sequence = 0; sequence < 150; sequence++) {
    const expected = [], actual = [];
    const reference = createTurnReader(message => expected.push(message));
    const candidate = createTurnReader(message => actual.push({ role: message.role, text: message.text.text }), textPolicy);
    for (let row = 0; row < 35; row++) {
      const text = texts[next(texts.length)];
      const payload = next(2) ? { type: ['user_message', 'task_complete', 'task_started', 'turn_aborted'][next(4)],
        message: text, last_agent_message: texts[next(texts.length)] }
        : { type: 'message', role: ['user', 'assistant', 'tool'][next(3)],
          phase: [undefined, 'final_answer', 'commentary'][next(3)],
          content: [{ text, type: 'input_text' }, { type: ['output_text', 'tool_result'][next(2)], text: texts[next(texts.length)] }] };
      const record = { type: payload.type === 'message' ? 'response_item' : 'event_msg', payload };
      const projection = createConversationProjection(textProjection(row, 'hello'));
      const encoded = Buffer.from(JSON.stringify(record));
      for (let at = 0; at < encoded.length; at += 13) projection.write(encoded.subarray(at, at + 13));
      reference.accept(record); candidate.accept(projection.finish());
    }
    assert.deepEqual(candidate.finish(), reference.finish());
    assert.deepEqual(actual, expected);
  }
});

test('duplicate content arrays and overwritten text use only the final JSON value', () => {
  const json = '{"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"obsolete"}],"content":[' +
    '{"type":"input_text","text":"a","text":"b"},{"type":"output_text","text":""},{"type":"input_text","text":"c"}]},"type":"response_item"}';
  const result = [], reader = createTurnReader(message => result.push(message.text), textPolicy);
  const projection = createConversationProjection(textProjection(0, 'b\n\n\n\nc'));
  projection.write(Buffer.from(json)); reader.accept(projection.finish()); reader.finish();
  assert.equal(result[0].text, 'b\n\n\n\nc');
  assert.equal(result[0].hit.at, 0);
});
