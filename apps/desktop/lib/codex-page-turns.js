'use strict';
// Read-only presentation policy. Explicit final/completion markers are evidence;
// unlabelled assistant text at EOF is never guessed to be a terminal answer.
function createTurnReader(emit, policy = {}, saved = {}) {
  const restore = value => value == null ? null : policy.restore ? policy.restore(value) : value;
  let prompt = restore(saved.prompt), mirror = restore(saved.mirror), answer = restore(saved.answer), unknown = restore(saved.unknown);
  let waiting = saved.waiting || false, ambiguous = saved.ambiguous || 0, completedAnswer = restore(saved.completedAnswer);
  const check = policy.check || (text => {
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Object.assign(new Error('MESSAGE_TOO_LARGE'), { code: 'MESSAGE_TOO_LARGE' });
    return text;
  });
  const isText = policy.isText || (text => typeof text === 'string');
  const equal = policy.equal || ((a, b) => a === b);
  function flushPrompt() {
    if (prompt !== null) { emit({ role: 'user', text: prompt }); waiting = true; prompt = null; }
  }
  function complete(text, completed = false) {
    flushPrompt();
    const final = isText(text) && text.length ? text : answer || (completed ? unknown : null);
    if (final && !equal(final, completedAnswer)) { emit({ role: 'assistant', text: check(final) }); waiting = false; }
    else if (unknown) ambiguous++;
    answer = unknown = null; mirror = null;
    if (completed) { waiting = false; completedAnswer = final; }
  }
  function isSetup(text) {
    if (policy.setup) return policy.setup(text);
    return /^(?:# AGENTS\.md instructions\b|<environment_context>|<INSTRUCTIONS>|<permissions instructions>|<skills_instructions>)/.test(text.trim());
  }
  return {
    checkpoint: () => ({ prompt, mirror, answer, unknown, waiting, ambiguous, completedAnswer }),
    accept(record) {
      const p = record?.payload;
      if (!p || typeof p !== 'object') return;
      if (record.type === 'event_msg') {
        if (['task_started', 'turn_started'].includes(p.type)) { complete(); completedAnswer = null; return; }
        if (p.type === 'user_message' && isText(p.message) && p.message.length) {
          // A response_item immediately preceding its event is a mirror.
          if (equal(prompt, p.message)) prompt = null;
          complete(); completedAnswer = null; emit({ role: 'user', text: check(p.message) });
          mirror = p.message; waiting = true; return;
        }
        if (['task_complete', 'turn_complete'].includes(p.type)) complete(p.last_agent_message, true);
        if (p.type === 'turn_aborted') { flushPrompt(); answer = unknown = null; waiting = false; }
        return;
      }
      if (record.type !== 'response_item' || p.type !== 'message' || !Array.isArray(p.content)) return;
      const text = policy.join ? policy.join(p.content) : p.content.filter(b => ['input_text', 'output_text'].includes(b?.type) && typeof b.text === 'string')
        .map(b => b.text).join('\n\n');
      if (!text?.length) return;
      if (p.role === 'user') {
        if (equal(mirror, text)) { mirror = null; return; }
        if (isSetup(text)) return;
        complete(); completedAnswer = null; prompt = check(text); return;
      }
      if (p.role !== 'assistant') return;
      flushPrompt(); mirror = null;
      if (p.phase === 'final_answer' || p.channel === 'final') answer = check(text);
      else if (!p.phase && !p.channel) unknown = check(text);
    },
    discontinuity() {
      // Preserve an already explicit final, but never promote unlabelled text
      // using completion evidence from the other side of an unreadable boundary.
      complete();
      answer = unknown = prompt = mirror = completedAnswer = null;
      waiting = false;
    },
    finish() { complete(); return { waiting, ambiguous }; },
  };
}
module.exports = { createTurnReader };
