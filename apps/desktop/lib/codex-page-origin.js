'use strict';
const { createZstdSession } = require('./codex-page-zstd-stream');
const fs = require('node:fs/promises');
const HEADER_BYTES = 1024 * 1024;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasParent(value, sessionId) {
  return typeof value === 'string' && THREAD_ID.test(value) && value.toLowerCase() !== sessionId.toLowerCase();
}

function isSubagent(source, sessionId) {
  const agent = source?.subagent;
  if (['review', 'compact', 'memory_consolidation'].includes(agent)) return true;
  if (typeof agent?.other === 'string' && agent.other.trim()) return true;
  const spawn = agent?.thread_spawn;
  return hasParent(spawn?.parent_thread_id, sessionId) && Number.isInteger(spawn.depth) && spawn.depth >= 1;
}

function classifyHeader(record, sessionId) {
  if (record?.type !== 'session_meta' || !record.payload || record.payload.id !== sessionId) return 'unknown';
  const { source, thread_source: threadSource } = record.payload;
  // Codex protocol + ext/guardian-reviewer/src/session.rs: structured provenance,
  // never a title, prompt substring, JSON answer, or the presence of a short ID.
  if (threadSource === 'guardian_review' || source?.internal === 'guardian' ||
      source?.subagent?.other === 'guardian') return 'review';
  // Codex protocol SessionSource / ThreadSource and session_meta parent provenance.
  // A user-created fork (forked_from_id) alone is not a background session.
  if (['subagent', 'memory_consolidation'].includes(threadSource) ||
      source?.internal === 'memory_consolidation' || isSubagent(source, sessionId) ||
      hasParent(record.payload.parent_thread_id, sessionId)) return 'background';
  // A non-interactive launch can still have thread_source=user; transport wins.
  // Codex's default interactive source list excludes exec and MCP/app-server.
  if (source === 'exec' || source === 'mcp') return 'automation';
  if (threadSource === 'user' || ['cli', 'vscode'].includes(source) ||
      ['atlas', 'chatgpt'].includes(source?.custom)) return 'user';
  return 'unknown';
}

// A bounded, conservative probe for abandoned initialization files. Never infer
// emptiness from a title, missing final answer, unsupported content or parse failure.
async function initializationOnly(stream) {
  if (stream.snapshot.size > 128 * 1024) return false;
  try {
    for await (const item of stream.rawRecords()) {
      if (item.end > 128 * 1024 || !item.text?.endsWith('\n')) return false;
      const record = JSON.parse(item.text);
      if (record?.type === 'turn_context' && record.payload && typeof record.payload === 'object') continue;
      if (record?.type === 'event_msg' && ['token_count', 'thread_settings_applied'].includes(record.payload?.type)) continue;
      if (record?.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user') {
        const content = record.payload.content;
        if (Array.isArray(content) && content.length && content.every(b => b.type === 'input_text' && typeof b.text === 'string' &&
          /^(?:# AGENTS\.md instructions\b|<environment_context>|<INSTRUCTIONS>|<permissions instructions>|<skills_instructions>)/.test(b.text.trim()))) continue;
      }
      return false;
    }
    return true; // Verified EOF, no prompt, answer, image, unknown record or unfinished line.
  } catch { return false; }
}

async function readOrigin(source, cached) {
  let stream;
  try {
    if (cached?.snapshot) {
      const stat = await fs.lstat(source.filePath);
      if (stat.isFile() && Object.keys(cached.snapshot).every(key => cached.snapshot[key] === stat[key])) {
        const { validateAncestorChain } = await import('../tools/session-import/lib/output-root.mjs');
        await validateAncestorChain(source.filePath);
        if (await fs.realpath(source.filePath) === source.filePath) return { ...cached, cached: true };
      }
    }
    stream = await createZstdSession(source, { allowPlain: true, maxDecodedBytes: HEADER_BYTES });
    const text = await stream.readHeader();
    const record = JSON.parse(text);
    let origin = classifyHeader(record, source.sessionId);
    if (origin === 'user' && await initializationOnly(stream)) origin = 'empty';
    const cwd = record?.type === 'session_meta' && record.payload?.id === source.sessionId &&
      typeof record.payload.cwd === 'string' && record.payload.cwd.startsWith('/') && record.payload.cwd.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(record.payload.cwd) ? record.payload.cwd : '';
    return { origin, cwd, snapshot: stream.snapshot };
  } catch {
    // Optional provenance must never make an otherwise readable conversation vanish.
    return { origin: 'unknown' };
  } finally { await stream?.close(); }
}
module.exports = { readOrigin, classifyHeader, HEADER_BYTES };
