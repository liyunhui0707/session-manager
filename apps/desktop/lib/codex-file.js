'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseCodexConversation } = require('./codex-conversation');
const MAX_CODEX_BYTES = 50 * 1024 * 1024;

async function loadCodexFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) ||
      path.resolve(filePath) !== filePath ||
      !/^rollout-.+\.jsonl$/.test(path.basename(filePath))) {
    throw new TypeError('Select a rollout JSONL file');
  }
  const { validateAncestorChain } = await import('../tools/session-import/lib/output-root.mjs');
  const { readSessionFileSafe } = await import('../tools/session-import/lib/safe-read.mjs');
  await validateAncestorChain(filePath);
  const parent = path.dirname(filePath);
  const canonicalRoot = await fs.realpath(parent);
  if (canonicalRoot !== path.resolve(parent)) throw new Error('Unsafe source ancestor');
  const { buf } = await readSessionFileSafe(filePath, canonicalRoot, MAX_CODEX_BYTES);
  // Recheck ancestors after the descriptor read as well; never return a snapshot
  // selected through an ancestor that has since become a symbolic link.
  await validateAncestorChain(filePath);
  return {
    name: path.basename(filePath),
    sourceBytes: buf.length,
    conversation: parseCodexConversation(buf.toString('utf8')),
  };
}

async function loadCodexCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object' ||
      typeof entry.filePath !== 'string' || !path.isAbsolute(entry.filePath) ||
      path.resolve(entry.filePath) !== entry.filePath ||
      typeof entry.canonicalRoot !== 'string' || !path.isAbsolute(entry.canonicalRoot) ||
      !/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/.test(path.basename(entry.filePath)) ||
      !(entry.filePath === entry.canonicalRoot || entry.filePath.startsWith(entry.canonicalRoot + path.sep))) {
    throw new TypeError('Invalid catalog entry');
  }
  const { validateAncestorChain } = await import('../tools/session-import/lib/output-root.mjs');
  const { readSessionFileSafe } = await import('../tools/session-import/lib/safe-read.mjs');
  await validateAncestorChain(entry.filePath);
  const { buf } = await readSessionFileSafe(entry.filePath, entry.canonicalRoot, MAX_CODEX_BYTES);
  await validateAncestorChain(entry.filePath);
  return {
    name: typeof entry.title === 'string' && entry.title ? entry.title : entry.sessionId,
    sourceBytes: buf.length,
    conversation: parseCodexConversation(buf.toString('utf8')),
  };
}

module.exports = { loadCodexFile, loadCodexCatalogEntry, MAX_CODEX_BYTES };
