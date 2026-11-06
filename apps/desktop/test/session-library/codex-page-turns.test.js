'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnReader } = require('../../lib/codex-page-turns');
const response = (role, text, phase) => ({ type: 'response_item', payload: {
  type: 'message', role, phase, content: [{ type: 'input_text', text }],
} });
const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
function read(records) {
  const messages = [], reader = createTurnReader(m => messages.push(m));
  for (const r of records) reader.accept(r);
  return { messages, ...reader.finish() };
}
test('reader keeps each real prompt and terminal answer, without mirrored messages or narration', () => {
  const result = read([
    response('user', '# AGENTS.md instructions\n<INSTRUCTIONS>setup</INSTRUCTIONS>'),
    event('task_started'), response('user', 'Question'), event('user_message', { message: 'Question' }),
    response('assistant', 'Working…', 'commentary'), response('assistant', 'Partial', 'partial_answer'),
    response('assistant', '**Answer**', 'final_answer'), event('task_complete', { last_agent_message: '**Answer**' }),
    event('task_started'), event('user_message', { message: 'Question' }), response('user', 'Question'),
    response('assistant', 'Again', 'final_answer'), event('task_complete', { last_agent_message: 'Again' }),
  ]);
  assert.deepEqual(result.messages, [
    { role: 'user', text: 'Question' }, { role: 'assistant', text: '**Answer**' },
    { role: 'user', text: 'Question' }, { role: 'assistant', text: 'Again' },
  ]);
  assert.equal(result.waiting, false);
});
test('unknown-phase output is withheld until completion, and interrupted turns do not become final answers', () => {
  assert.deepEqual(read([event('user_message', { message: 'Q' }), response('assistant', 'progress')]),
    { messages: [{ role: 'user', text: 'Q' }], waiting: true, ambiguous: 1 });
  assert.deepEqual(read([event('user_message', { message: 'Q' }), response('assistant', 'progress'),
    event('task_complete', { last_agent_message: 'Answer' })]).messages,
  [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'Answer' }]);
});
test('actual user events preserve literal setup-like text; completion mirrors are deduplicated per turn only', () => {
  const text = '<environment_context>This is my question</environment_context>';
  const r = read([event('user_message', { message: text }), response('user', text),
    response('assistant', 'yes', 'final_answer'), event('task_complete', { last_agent_message: 'yes' }),
    event('user_message', { message: text }), response('assistant', 'yes', 'final_answer')]);
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[0].text, text);
});
test('legacy unlabelled last answer is accepted only with a completion marker', () => {
  const result = read([event('user_message', { message: 'Q' }), response('assistant', 'Working'),
    response('assistant', 'Legacy answer'), event('task_complete')]);
  assert.deepEqual(result.messages, [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'Legacy answer' }]);
  assert.equal(result.waiting, false);
});
test('completion followed by its final response mirror produces one answer', () => {
  const result = read([event('user_message', { message: 'Q' }),
    event('task_complete', { last_agent_message: 'Answer' }),
    response('assistant', 'Answer', 'final_answer'), event('task_complete', { last_agent_message: 'Answer' }),
    event('task_started'), event('user_message', { message: 'Q' }),
    response('assistant', 'Answer', 'final_answer')]);
  assert.deepEqual(result.messages.map(m => m.text), ['Q', 'Answer', 'Q', 'Answer']);
});
