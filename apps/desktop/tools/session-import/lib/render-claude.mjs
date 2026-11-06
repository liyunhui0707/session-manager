import { jsonScalar, buildFence, truncate } from './render-utils.mjs';

const TOOL_INPUT_MAX = 4096;
const TOOL_RESULT_MAX = 4096;

export function decodeProjectPathGuess(name) {
  return name.replace(/-/g, '/');
}

function renderToolUse(blk, parts) {
  const name = typeof blk.name === 'string' ? blk.name : 'unknown';
  let inputStr;
  try {
    const s = JSON.stringify(blk.input, null, 2);
    inputStr = typeof s === 'string' ? s : String(blk.input);
  } catch {
    inputStr = String(blk.input);
  }
  const { rendered, truncated } = truncate(inputStr, TOOL_INPUT_MAX);
  const fence = buildFence(rendered);
  let section = `### Tool use: ${name}\n\n${fence}json\n${rendered}\n${fence}`;
  if (truncated) {
    section += `\n\n_… (truncated, original ${inputStr.length} chars)_`;
  }
  parts.push(section);
}

export function renderToolUseBlock(blk) {
  const parts = [];
  renderToolUse(blk || {}, parts);
  return parts.join('\n\n');
}

function renderToolResult(blk, parts) {
  const isError = blk.is_error === true;
  let content = blk.content;
  if (Array.isArray(content)) {
    content = content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  if (typeof content !== 'string') content = String(content ?? '');
  const { rendered, truncated } = truncate(content, TOOL_RESULT_MAX);
  const fence = buildFence(rendered);
  let section = `### Tool result${isError ? ' (error)' : ''}\n\n${fence}\n${rendered}\n${fence}`;
  if (truncated) {
    section += `\n\n_… (truncated, original ${content.length} chars)_`;
  }
  parts.push(section);
}

function renderUserRecord(obj, parts) {
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const heading = `## User${ts ? ` — ${ts}` : ''}`;
  const c = obj.message && obj.message.content;
  if (typeof c === 'string') {
    parts.push(`${heading}\n\n${c}`);
    return;
  }
  if (!Array.isArray(c)) return;
  const texts = [];
  const toolResults = [];
  for (const blk of c) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.type === 'text' && typeof blk.text === 'string') texts.push(blk.text);
    else if (blk.type === 'tool_result') toolResults.push(blk);
  }
  if (texts.length > 0) parts.push(`${heading}\n\n${texts.join('\n\n')}`);
  for (const tr of toolResults) renderToolResult(tr, parts);
}

function renderAssistantRecord(obj, parts) {
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const heading = `## Assistant${ts ? ` — ${ts}` : ''}`;
  const c = obj.message && obj.message.content;
  if (!Array.isArray(c)) return;
  const texts = [];
  const toolUses = [];
  for (const blk of c) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.type === 'text' && typeof blk.text === 'string') texts.push(blk.text);
    else if (blk.type === 'tool_use') toolUses.push(blk);
  }
  if (texts.length > 0) parts.push(`${heading}\n\n${texts.join('\n\n')}`);
  for (const tu of toolUses) renderToolUse(tu, parts);
}

export function renderTranscript(content, { includeRaw = false } = {}) {
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
    if (obj.type === 'user') renderUserRecord(obj, parts);
    else if (obj.type === 'assistant') renderAssistantRecord(obj, parts);
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

export function buildClaudeFrontmatter({
  projectName,
  uuid,
  lst,
  importStamp,
  enrichment,
}) {
  const fmLines = [
    '---',
    `title: ${jsonScalar('claude-code/' + projectName + '/' + uuid)}`,
    `agent: ${jsonScalar('claude-code')}`,
    `source: claude`,
    `imported_at: ${jsonScalar(importStamp.toISOString())}`,
    `source_session_id: ${jsonScalar(uuid)}`,
    `source_project_dir: ${jsonScalar(projectName)}`,
    `source_project_path_guess: ${jsonScalar(decodeProjectPathGuess(projectName))}`,
    `source_mtime: ${jsonScalar(lst.mtime.toISOString())}`,
    `source_bytes: ${jsonScalar(String(lst.size))}`,
  ];
  if (enrichment.cwd) {
    fmLines.push(`source_cwd: ${jsonScalar(enrichment.cwd)}`);
  }
  if (enrichment.version) {
    fmLines.push(`source_version: ${jsonScalar(enrichment.version)}`);
  }
  if (enrichment.sessionId && enrichment.sessionId !== uuid) {
    fmLines.push(`transcript_session_id: ${jsonScalar(enrichment.sessionId)}`);
  }
  if (enrichment.customTitle) {
    fmLines.push(`source_custom_title: ${jsonScalar(enrichment.customTitle)}`);
  }
  if (enrichment.aiTitle) {
    fmLines.push(`source_ai_title: ${jsonScalar(enrichment.aiTitle)}`);
  }
  fmLines.push('---', '');
  return fmLines.join('\n') + '\n';
}

export function extractEnrichment(content, fileSessionId) {
  let cwd = null;
  let version = null;
  let sessionId = null;
  let customTitle = null;
  let aiTitle = null;
  const lines = String(content).split('\n');
  let firstUserSeen = false;
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
    if (!firstUserSeen && obj.type === 'user') {
      if (typeof obj.cwd === 'string') cwd = obj.cwd;
      if (typeof obj.version === 'string') version = obj.version;
      if (typeof obj.sessionId === 'string') sessionId = obj.sessionId;
      firstUserSeen = true;
      continue;
    }
    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
      if (typeof obj.sessionId === 'string' && obj.sessionId !== fileSessionId) continue;
      customTitle = obj.customTitle;
      continue;
    }
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      if (typeof obj.sessionId === 'string' && obj.sessionId !== fileSessionId) continue;
      aiTitle = obj.aiTitle;
      continue;
    }
  }
  return { cwd, version, sessionId, customTitle, aiTitle };
}
