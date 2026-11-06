'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createZstdDecompress, constants: z } = require('node:zlib');
const { createFastProjection: createConversationProjection } = require('./codex-page-fast');
const { parseCodexConversation } = require('./codex-conversation');
const { PAGE_MESSAGES, PAGE_TEXT_BYTES, MAX_RECORD_BYTES } = require('./codex-page-limits');
const { prepareAppend } = require('./codex-page-append');
const MAX_DECODED_BYTES = 16 * 1024 ** 3;
const WINDOW_LOG = 23; // Native decoder memory is bounded separately from V8.
const CHUNK_BYTES = 64 * 1024;
const failure = code => Object.assign(new Error(code), { code });
const identity = s => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const same = (a, b) => Object.keys(a).every(key => a[key] === b[key]);

async function createZstdSession(source, { maxDecodedBytes = MAX_DECODED_BYTES, allowPlain = false, skipOversizedRecords = false, projectConversation = false, projectionOptions, trackAppend = false, append, resume } = {}) {
  const { filePath, canonicalRoot, snapshot } = source;
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.resolve(filePath) !== filePath ||
      !(allowPlain ? /^rollout-.+\.jsonl(?:\.zst)?$/ : /^rollout-.+\.jsonl\.zst$/).test(path.basename(filePath)) ||
      typeof canonicalRoot !== 'string' || !path.isAbsolute(canonicalRoot) ||
      path.resolve(canonicalRoot) !== canonicalRoot || !filePath.startsWith(canonicalRoot + path.sep)) throw failure('INVALID_SOURCE');
  if (!createZstdDecompress || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw failure('PLATFORM_UNSUPPORTED');
  const { validateAncestorChain } = await import('../tools/session-import/lib/output-root.mjs');
  await validateAncestorChain(filePath);
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let decoder, pumping, iterator, pending = null, decodedBytes = 0, cursor = 0, ended = false;
  let compressedReads = 0, closed = false;
  async function close() {
    if (closed) return;
    closed = true; decoder?.destroy();
    await pumping?.catch(() => {});
    await handle.close();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw failure('INVALID_SOURCE');
    const current = identity(stat);
    if (snapshot && !same(current, snapshot)) throw failure('SOURCE_CHANGED');
    async function verify() {
      await validateAncestorChain(filePath);
      if (await fs.realpath(filePath) !== filePath || !same(current, identity(await fs.stat(filePath))) ||
          !same(current, identity(await handle.stat()))) throw failure('SOURCE_CHANGED');
    }
    await verify();
    const plain = allowPlain && !filePath.endsWith('.zst');
    const fingerprint = plain && trackAppend ? await prepareAppend(handle, current, append, verify) : null;
    if (resume && (!snapshot || !Number.isSafeInteger(resume.offset) || resume.offset < 0 ||
        resume.offset > (plain ? stat.size : maxDecodedBytes) || !Number.isSafeInteger(resume.records) || resume.records < 0)) throw failure('INVALID_SOURCE');
    const startOffset = resume?.offset ?? fingerprint?.offset ?? 0;
    decodedBytes = plain ? startOffset : 0;
    let fullyRead = false;
    // Node's Zstd decoder stops at the first frame. bytesWritten gives the
    // consumed compressed bytes; reopen a decoder for every following frame.
    // Positional descriptor reads also avoid stream auto-close races on errors.
    async function* chunks() {
      if (plain) {
        for (let position = startOffset; position < stat.size;) {
          const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - position));
          const read = await handle.read(chunk, 0, chunk.length, position);
          if (!read.bytesRead) throw failure('SOURCE_CHANGED');
          position += read.bytesRead;
          const bytes = chunk.subarray(0, read.bytesRead); fingerprint?.update(bytes); yield bytes;
        }
        return;
      }
      if (stat.size === 0) throw failure('DECOMPRESSION_FAILED');
      let frameStart = 0;
      while (frameStart < stat.size) {
        decoder = createZstdDecompress({ chunkSize: CHUNK_BYTES, highWaterMark: CHUNK_BYTES,
          params: { [z.ZSTD_d_windowLogMax]: WINDOW_LOG } });
        const currentDecoder = decoder;
        pumping = (async () => {
          let position = frameStart;
          while (position < stat.size && !closed) {
            const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - position));
            const read = await handle.read(buffer, 0, buffer.length, position);
            if (!read.bytesRead) throw failure('SOURCE_CHANGED');
            compressedReads += read.bytesRead;
            await new Promise((resolve, reject) => {
              const finish = error => {
                currentDecoder.removeListener('error', onError);
                currentDecoder.removeListener('close', onClose);
                error ? reject(error) : resolve();
              };
              const onError = error => finish(error);
              const onClose = () => finish(failure('DECOMPRESSION_FAILED'));
              currentDecoder.once('error', onError); currentDecoder.once('close', onClose);
              currentDecoder.write(buffer.subarray(0, read.bytesRead), finish);
            });
            position += read.bytesRead;
            if (currentDecoder.bytesWritten < position - frameStart || currentDecoder.readableEnded) break;
          }
          currentDecoder.end();
        })();
        pumping.catch(error => currentDecoder.destroy(error));
        for await (const chunk of currentDecoder) yield chunk;
        await pumping;
        const consumed = currentDecoder.bytesWritten;
        if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > stat.size - frameStart) throw failure('DECOMPRESSION_FAILED');
        frameStart += consumed;
      }
    }
    async function* records(batched = false) {
      let parts = [], length = 0, position = plain ? startOffset : 0, oversized = false;
      let projection, projectionError, recordNumber = resume?.records ?? fingerprint?.records ?? 0;
      const reset = () => {
        parts = []; length = 0; oversized = false; projectionError = null;
        projection = projectConversation ? createConversationProjection(projectionOptions?.(recordNumber++)) : null;
      };
      const projectError = error => {
        if (error instanceof SyntaxError) return 'malformed';
        if (error.code === 'MESSAGE_TOO_LARGE') return 'oversizedMessage';
        if (error.code === 'JSON_LIMIT') return 'oversized';
        throw error;
      };
      const finish = (end, terminated) => {
        if (!projectConversation) return oversized ? { oversized: true, end }
          : { text: Buffer.concat(parts, length).toString('utf8'), end };
        let value;
        if (!projectionError) {
          try { value = projection.finish(); } catch (error) { projectionError = projectError(error); }
        }
        return projectionError ? { [projectionError]: true, end, terminated } : { value, end, terminated };
      };
      reset();
      function append(piece) {
        if (projectConversation) {
          length += piece.length;
          if (!projectionError) {
            try { projection.write(piece); } catch (error) { projectionError = projectError(error); projection = null; }
          }
          return;
        }
        if (oversized) return;
        length += piece.length;
        if (length > MAX_RECORD_BYTES) {
          if (!skipOversizedRecords) throw failure('RECORD_TOO_LARGE');
          // Drain to the next physical JSONL boundary without retaining more bytes.
          oversized = true; parts = []; length = 0;
        } else parts.push(piece);
      }
      try {
        for await (let chunk of chunks()) {
          decodedBytes += chunk.length;
          if (decodedBytes > maxDecodedBytes) throw failure('DECOMPRESSION_LIMIT');
          // Zstd cannot seek within a frame. Decode and validate its prefix,
          // but reuse verified parser state instead of parsing those bytes again.
          if (!plain && position < startOffset) {
            const skipped = Math.min(chunk.length, startOffset - position);
            position += skipped; chunk = chunk.subarray(skipped);
            if (!chunk.length) continue;
          }
          let start = 0, batch = [];
          for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
            const piece = chunk.subarray(start, i + 1);
            append(piece);
            const record = finish(position + i + 1, true);
            if (batched) { batch.push(record); if (batch.length === 64) { yield batch; batch = []; } }
            else yield record;
            reset(); start = i + 1;
          }
          if (start < chunk.length) {
            const piece = chunk.subarray(start);
            append(piece);
          }
          if (batch.length) yield batch;
          position += chunk.length;
        }
        await pumping; // Do not accept a truncated decoder EOF.
        if (position < startOffset) throw failure('DECOMPRESSION_FAILED');
        if (oversized || length) {
          const record = finish(position, false);
          yield batched ? [record] : record;
        }
      } catch (error) {
        if (['DECOMPRESSION_LIMIT', 'RECORD_TOO_LARGE'].includes(error.code)) throw error;
        if (error.code === 'ZSTD_error_frameParameter_windowTooLarge') throw failure('DECOMPRESSION_LIMIT');
        throw failure('DECOMPRESSION_FAILED');
      }
    }
    iterator = records();
    async function next() {
      const item = await iterator.next();
      ended = item.done;
      return item.done ? null : item.value;
    }
    return {
      close, verify,
      snapshot: current,
      appendResumed: !!(fingerprint && append),
      get appendDigest() { return fullyRead && fingerprint ? fingerprint.digest() : null; },
      async readHeader() {
        // This separate provenance probe never parses subsequent transcript records.
        // The caller bounds decoded bytes; one 64 KiB buffer may read ahead.
        const record = await next();
        await verify();
        return record?.text?.endsWith('\n') ? record.text : null;
      },
      // The conversation worker consumes bounded batches, avoiding one async
      // promise chain per tiny JSONL record. Other clients retain single records.
      async *rawRecordBatches() {
        await verify();
        for await (const batch of records(true)) yield batch;
        await verify();
        fullyRead = true;
      },
      async *rawRecords() {
        await verify();
        for await (const record of iterator) yield record;
        await verify();
        fullyRead = true;
      },
      get cursor() { return cursor; },
      async read(offset, expected) {
        if (!Number.isSafeInteger(offset) || offset < cursor || (expected && !same(current, expected))) throw failure('SOURCE_CHANGED');
        await verify();
        // Replays happen only after backward movement, cancellation or idle eviction.
        while (cursor < offset) {
          const record = pending || await next(); pending = null;
          if (!record || record.end > offset) throw failure('INVALID_SOURCE');
          cursor = record.end;
        }
        const conversation = parseCodexConversation('');
        let textBytes = 0;
        const start = cursor;
        for (;;) {
          const record = pending || (ended ? null : await next()); pending = null;
          if (!record) break;
          const parsed = parseCodexConversation(record.text);
          const size = parsed.messages.reduce((n, m) => n + Buffer.byteLength(m.text), 0);
          if (size > PAGE_TEXT_BYTES) throw failure('MESSAGE_TOO_LARGE');
          if (textBytes + size > PAGE_TEXT_BYTES) { pending = record; break; }
          conversation.messages.push(...parsed.messages);
          for (const key of Object.keys(conversation.diagnostics)) conversation.diagnostics[key] += parsed.diagnostics[key];
          cursor = record.end; textBytes += size;
          if (conversation.messages.length >= PAGE_MESSAGES || cursor - start >= 4 * 1024 * 1024) {
            pending = await next(); break;
          }
        }
        await verify();
        return { conversation, snapshot: current, nextOffset: cursor, hasNext: pending !== null || !ended,
          compressed: true, decodedBytes, bytesRead: compressedReads };
      },
    };
  } catch (error) { await close(); throw error; }
}
module.exports = { createZstdSession, MAX_DECODED_BYTES, WINDOW_LOG };
