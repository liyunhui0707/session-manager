'use strict';
const { createHash } = require('node:crypto');
const CHECKPOINT_BYTES = 2 * 1024 ** 2;
const mismatch = () => Object.assign(new Error('APPEND_MISMATCH'), { code: 'APPEND_MISMATCH' });

// A growing inode alone does not prove append-only writing. Verify every old
// byte on the already safely opened descriptor before reusing parser state.
async function prepareAppend(handle, snapshot, previous, verify) {
  const hash = createHash('sha256');
  let offset = 0, records = 0;
  if (previous) {
    if (previous.snapshot?.dev !== snapshot.dev || previous.snapshot?.ino !== snapshot.ino ||
        previous.offset !== previous.snapshot.size || !Number.isSafeInteger(previous.offset) || previous.offset < 0 ||
        previous.offset > snapshot.size || !Number.isSafeInteger(previous.records) || previous.records < 0 ||
        !/^[a-f0-9]{64}$/.test(previous.digest)) throw mismatch();
    const buffer = Buffer.alloc(1024 * 1024);
    while (offset < previous.offset) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, previous.offset - offset), offset);
      if (!bytesRead) throw mismatch();
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    await verify();
    if (hash.copy().digest('hex') !== previous.digest) throw mismatch();
    records = previous.records;
  }
  return { offset, records, update: chunk => hash.update(chunk), digest: () => hash.copy().digest('hex') };
}

function makeCheckpoint(cursor, state) {
  // Descriptor-backed pending text needs historical extraction. Keep the
  // ordinary append path small and fall back rather than retaining huge bodies.
  const bodies = Object.values(state.turn).filter(value => value && typeof value === 'object');
  const messages = [...state.messages, ...state.window.flatMap(page => page.messages)];
  if (bodies.some(body => body.text === undefined) || messages.some(message => message.body)) return null;
  if ([...bodies, ...messages].reduce((bytes, value) => bytes + Buffer.byteLength(value.text || ''), 0) > CHECKPOINT_BYTES) return null;
  const json = JSON.stringify({ ...cursor, state });
  // JSON cloning snapshots the state before EOF presentation flush mutates it.
  return Buffer.byteLength(json) <= CHECKPOINT_BYTES ? JSON.parse(json) : null;
}
module.exports = { prepareAppend, makeCheckpoint, CHECKPOINT_BYTES };
