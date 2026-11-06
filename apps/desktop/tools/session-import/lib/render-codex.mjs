import { jsonScalar, buildFence, truncate } from './render-utils.mjs';

const TOOL_INPUT_MAX = 4096;
const TOOL_RESULT_MAX = 4096;

function renderUserOrAssistant(obj, parts) {
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const role = obj.payload.role;
  const heading = `## ${role === 'user' ? 'User' : 'Assistant'}${ts ? ` — ${ts}` : ''}`;
  const content = obj.payload.content;
  if (!Array.isArray(content)) return;
  const texts = [];
  for (const blk of content) {
    if (!blk || typeof blk !== 'object') continue;
    if (
      (blk.type === 'input_text' || blk.type === 'output_text') &&
      typeof blk.text === 'string'
    ) {
      texts.push(blk.text);
    }
  }
  const text = texts.join('\n\n');
  if (text.length === 0) return;
  parts.push(`${heading}\n\n${text}`);
}

function renderFunctionCall(obj, parts) {
  const p = obj.payload;
  const name = typeof p.name === 'string' ? p.name : 'unknown';
  let inputStr;
  if (typeof p.arguments === 'string') {
    try {
      const parsed = JSON.parse(p.arguments);
      const pretty = JSON.stringify(parsed, null, 2);
      inputStr = typeof pretty === 'string' ? pretty : p.arguments;
    } catch {
      inputStr = p.arguments;
    }
  } else {
    inputStr = String(p.arguments ?? '');
  }
  const { rendered, truncated } = truncate(inputStr, TOOL_INPUT_MAX);
  const fence = buildFence(rendered);
  let section = `### Tool use: ${name}\n\n${fence}json\n${rendered}\n${fence}`;
  if (truncated) {
    section += `\n\n_… (truncated, original ${inputStr.length} chars)_`;
  }
  parts.push(section);
}

function renderFunctionCallOutput(obj, parts, erroredCallIds) {
  const p = obj.payload;
  const callId = typeof p.call_id === 'string' ? p.call_id : '';
  const isError = !!(erroredCallIds && erroredCallIds.has(callId));
  let raw = p.output;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      raw = JSON.stringify(raw, null, 2);
    } catch {
      raw = String(raw);
    }
  }
  let content;
  if (raw === null || raw === undefined) content = '';
  else if (typeof raw === 'string') content = raw;
  else content = String(raw);
  const { rendered, truncated } = truncate(content, TOOL_RESULT_MAX);
  const headingErr = isError ? ' (error)' : '';
  let section;
  if (rendered === '') {
    section = `### Tool result${headingErr}`;
  } else {
    const fence = buildFence(rendered);
    section = `### Tool result${headingErr}\n\n${fence}\n${rendered}\n${fence}`;
  }
  if (truncated) {
    section += `\n\n_… (truncated, original ${content.length} chars)_`;
  }
  parts.push(section);
}

export function renderTranscript(content, options) {
  const { includeRaw = false, erroredCallIds = null } = options || {};
  const parts = [];
  const lines = String(content).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type !== 'response_item') continue;
    const p = obj.payload;
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'message') {
      const role = p.role;
      if (role !== 'user' && role !== 'assistant') continue;
      renderUserOrAssistant(obj, parts);
    } else if (p.type === 'function_call') {
      renderFunctionCall(obj, parts);
    } else if (p.type === 'function_call_output') {
      renderFunctionCallOutput(obj, parts, erroredCallIds);
    }
  }
  let body = parts.join('\n\n');
  if (body && !body.endsWith('\n')) body += '\n';
  if (includeRaw) {
    const raw = content.endsWith('\n') ? content : content + '\n';
    const fence = buildFence(raw);
    const rawSection = `## Raw transcript\n\n${fence}jsonl\n${raw}${fence}\n`;
    body = body ? body + '\n' + rawSection : rawSection;
  }
  return body;
}

export function computeErroredCallIds(content) {
  const errored = new Set();
  const lines = String(content).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const p = obj.payload;
    if (!p || typeof p !== 'object') continue;
    const callId = typeof p.call_id === 'string' ? p.call_id : null;
    if (!callId) continue;
    if (obj.type === 'event_msg') {
      if (
        p.type === 'exec_command_end' &&
        typeof p.exit_code === 'number' &&
        p.exit_code !== 0
      ) {
        errored.add(callId);
      } else if (p.type === 'patch_apply_end' && p.success === false) {
        errored.add(callId);
      }
    } else if (
      obj.type === 'response_item' &&
      p.type === 'function_call_output'
    ) {
      const out = p.output;
      if (out && typeof out === 'object' && !Array.isArray(out)) {
        const e = out.error;
        if (e !== undefined && e !== null && String(e).length > 0) {
          errored.add(callId);
        }
      }
    }
  }
  return errored;
}

export function extractEnrichment(content) {
  let cwd = null;
  let version = null;
  let sessionId = null;
  let model = null;
  const lines = String(content).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const p = obj.payload;
    if (!p || typeof p !== 'object') continue;
    if (obj.type === 'session_meta') {
      if (typeof p.cwd === 'string' && cwd === null) cwd = p.cwd;
      if (typeof p.cli_version === 'string' && version === null)
        version = p.cli_version;
      if (typeof p.id === 'string' && sessionId === null) sessionId = p.id;
    } else if (obj.type === 'turn_context') {
      if (typeof p.model === 'string' && model === null) model = p.model;
    }
  }
  return { cwd, version, sessionId, model };
}

export function buildFrontmatter({
  title,
  sessionId,
  customTitle,
  pathSegments,
  lst,
  importStamp,
  enrichment,
  sourceLine,
}) {
  const fmLines = [
    '---',
    `title: ${jsonScalar(title)}`,
    `agent: ${jsonScalar('codex')}`,
  ];
  if (sourceLine) fmLines.push(sourceLine);
  fmLines.push(
    `imported_at: ${jsonScalar(importStamp.toISOString())}`,
    `source_session_id: ${jsonScalar(sessionId)}`,
    `source_path_segments: ${jsonScalar(pathSegments)}`,
    `source_mtime: ${jsonScalar(lst.mtime.toISOString())}`,
    `source_bytes: ${jsonScalar(String(lst.size))}`,
  );
  if (customTitle) {
    fmLines.push(`source_custom_title: ${jsonScalar(customTitle)}`);
  }
  if (enrichment.cwd) {
    fmLines.push(`source_cwd: ${jsonScalar(enrichment.cwd)}`);
  }
  if (enrichment.version) {
    fmLines.push(`source_version: ${jsonScalar(enrichment.version)}`);
  }
  if (enrichment.model) {
    fmLines.push(`model: ${jsonScalar(enrichment.model)}`);
  }
  if (enrichment.sessionId && enrichment.sessionId !== sessionId) {
    fmLines.push(`transcript_session_id: ${jsonScalar(enrichment.sessionId)}`);
  }
  fmLines.push('---', '');
  return fmLines.join('\n') + '\n';
}

export const ROLLOUT_FILE_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export const YEAR_RE = /^\d{4}$/;
export const MONTH_RE = /^(0[1-9]|1[0-2])$/;
export const DAY_RE = /^(0[1-9]|[12]\d|3[01])$/;

export function extractSessionId(fileName) {
  const m = fileName.match(
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
  );
  return m ? m[1] : '';
}
