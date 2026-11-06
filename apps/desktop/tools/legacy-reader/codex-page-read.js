'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { parseCodexConversation } = require('../../lib/codex-conversation');
const PAGE_MESSAGES = 100;
const PAGE_TEXT_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const SCAN_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const failure = code => Object.assign(new Error(code), { code });
const identity = s => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const same = (a, b) => Object.keys(a).every(key => a[key] === b[key]);

// Only the main process supplies these paths/offsets. Each page uses one checked
// descriptor, and is published only after the source identity is rechecked.
async function readCodexPage({ filePath, canonicalRoot, offset = 0, snapshot }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.resolve(filePath) !== filePath ||
      !/^rollout-.+\.jsonl$/.test(path.basename(filePath)) ||
      typeof canonicalRoot !== 'string' || !path.isAbsolute(canonicalRoot) ||
      path.resolve(canonicalRoot) !== canonicalRoot || !filePath.startsWith(canonicalRoot + path.sep) ||
      !Number.isSafeInteger(offset) || offset < 0) throw failure('INVALID_SOURCE');
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw failure('PLATFORM_UNSUPPORTED');
  const { validateAncestorChain } = await import('../session-import/lib/output-root.mjs');
  await validateAncestorChain(filePath);
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || offset > stat.size) throw failure('INVALID_SOURCE');
    const current = identity(stat);
    if (snapshot && !same(current, snapshot)) throw failure('SOURCE_CHANGED');
    async function verify() {
      await validateAncestorChain(filePath);
      if (await fs.realpath(filePath) !== filePath ||
          !same(current, identity(await fs.stat(filePath))) ||
          !same(current, identity(await handle.stat()))) throw failure('SOURCE_CHANGED');
    }
    await verify();
    const conversation = parseCodexConversation('');
    let bytesRead = 0, nextOffset = offset, textBytes = 0;
    async function* records() {
      let position = offset, parts = [], length = 0;
      while (position < stat.size) {
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - position));
        const read = await handle.read(chunk, 0, chunk.length, position);
        if (!read.bytesRead) throw failure('SOURCE_CHANGED');
        bytesRead += read.bytesRead;
        let start = 0;
        for (let i = 0; i < read.bytesRead; i++) {
          if (chunk[i] !== 10) continue;
          const piece = chunk.subarray(start, i + 1);
          if (length + piece.length > MAX_RECORD_BYTES) throw failure('RECORD_TOO_LARGE');
          parts.push(piece);
          yield { text: Buffer.concat(parts, length + piece.length).toString('utf8'), end: position + i + 1 };
          parts = []; length = 0; start = i + 1;
        }
        if (start < read.bytesRead) {
          const piece = chunk.subarray(start, read.bytesRead);
          length += piece.length;
          if (length > MAX_RECORD_BYTES) throw failure('RECORD_TOO_LARGE');
          parts.push(piece);
        }
        position += read.bytesRead;
      }
      if (length) yield { text: Buffer.concat(parts, length).toString('utf8'), end: stat.size };
    }
    for await (const record of records()) {
      const parsed = parseCodexConversation(record.text);
      const size = parsed.messages.reduce((n, m) => n + Buffer.byteLength(m.text), 0);
      if (size > PAGE_TEXT_BYTES) throw failure('MESSAGE_TOO_LARGE');
      if (textBytes + size > PAGE_TEXT_BYTES) break;
      conversation.messages.push(...parsed.messages);
      for (const key of Object.keys(conversation.diagnostics)) conversation.diagnostics[key] += parsed.diagnostics[key];
      textBytes += size;
      nextOffset = record.end;
      if (conversation.messages.length >= PAGE_MESSAGES || nextOffset - offset >= SCAN_BYTES) break;
    }
    await verify();
    return { conversation, nextOffset, snapshot: current, bytesRead };
  } finally { await handle.close(); }
}

module.exports = { readCodexPage, PAGE_MESSAGES, PAGE_TEXT_BYTES, MAX_RECORD_BYTES };
