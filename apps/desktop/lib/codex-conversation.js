'use strict';

// Pure interpretation of supported synthetic Codex record shapes. Source
// selection, safe byte limits, and filesystem access belong to the caller.
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCodexConversation(text) {
  if (typeof text !== 'string') {
    throw new TypeError('codex-conversation: text must be a string');
  }
  const messages = [];
  const diagnostics = {
    malformedRecords: 0,
    unparsedFinalRecord: 0,
    unsupportedRecords: 0,
    omittedContentBlocks: 0,
    excludedRecords: 0,
  };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A non-terminated last record may be unfinished OR corrupt.
      if (index === lines.length - 1) diagnostics.unparsedFinalRecord += 1;
      else diagnostics.malformedRecords += 1;
      continue;
    }
    if (!isObject(record) || !isObject(record.payload)) {
      diagnostics.unsupportedRecords += 1;
      continue;
    }
    if (['event_msg', 'session_meta', 'turn_context'].includes(record.type)) {
      diagnostics.excludedRecords += 1;
      continue;
    }
    const payload = record.payload;
    if (record.type !== 'response_item') {
      diagnostics.unsupportedRecords += 1;
      continue;
    }
    if (['function_call', 'function_call_output'].includes(payload.type)
      || (payload.type === 'message' && ['system', 'developer'].includes(payload.role))) {
      diagnostics.excludedRecords += 1;
      continue;
    }
    if (payload.type !== 'message' || !['user', 'assistant'].includes(payload.role)
      || !Array.isArray(payload.content)) {
      diagnostics.unsupportedRecords += 1;
      continue;
    }
    const blocks = [];
    for (const block of payload.content) {
      if (isObject(block) && ['input_text', 'output_text'].includes(block.type)
        && typeof block.text === 'string') blocks.push(block.text);
      else diagnostics.omittedContentBlocks += 1;
    }
    if (blocks.some((block) => block.length > 0)) {
      messages.push({ role: payload.role, text: blocks.join('\n\n') });
    }
  }
  return { messages, diagnostics };
}

module.exports = { parseCodexConversation };
