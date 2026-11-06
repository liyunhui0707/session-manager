'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitConversationMessage, PART_BYTES } = require('../../lib/codex-page-message-parts');
test('ordinary messages retain their original shape', () => {
  const message = { role: 'assistant', text: '**Hello**' };
  assert.deepEqual(splitConversationMessage(message), [{ message, start: 0 }]);
});
test('large messages reconstruct exactly, with bounded Unicode-safe parts', () => {
  const text = ('汉字🙂 **note**\n\n').repeat(40000), message = { role: 'assistant', text };
  const parts = splitConversationMessage(message);
  assert.ok(parts.length > 2);
  assert.equal(parts.map(p => p.message.text).join(''), text);
  for (const [index, part] of parts.entries()) {
    assert.ok(Buffer.byteLength(part.message.text) <= PART_BYTES);
    assert.equal(part.message.continuation.number, index + 1);
    assert.equal(part.message.continuation.total, parts.length);
    assert.equal(text.slice(part.start, part.start + part.message.text.length), part.message.text);
    assert.equal(part.message.text.includes('\uFFFD'), false);
  }
});
test('code context survives page boundaries and ends at the original fence', () => {
  const text = '```js\n' + 'const n = 42;\n'.repeat(65000) + '```\n\n**Finished**';
  const parts = splitConversationMessage({ role: 'assistant', text });
  assert.ok(parts[1].message.continuation.fenceMarker === 3);
  assert.equal(parts.map(p => p.message.text).join(''), text);
});
test('a long single line can be divided without inventing extra source newlines', () => {
  const text = '```\n' + 'a🙂'.repeat(150000) + '\n```';
  const parts = splitConversationMessage({ role: 'assistant', text });
  assert.equal(parts[1].message.continuation.startsMidLine, true);
  assert.equal(parts[1].message.continuation.fenceMarker, 3);
  assert.equal(parts.map(p => p.message.text).join(''), text);
});
test('question envelopes stay intact to preserve the question/answer presentation', () => {
  const text = '<send_user_message_question_reply>' + JSON.stringify([{question:'Q',answer:'x'.repeat(600000)}]) + '</send_user_message_question_reply>';
  assert.equal(splitConversationMessage({ role: 'user', text }).length, 1);
});
test('literal unpaired surrogate units are not silently rewritten by segmentation', () => {
  const text = ('x\ud800y\udc00').repeat(150000);
  assert.equal(splitConversationMessage({ role: 'assistant', text }).map(p => p.message.text).join(''), text);
});
