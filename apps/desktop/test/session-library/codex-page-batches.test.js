'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { zstdCompressSync } = require('node:zlib');
const { createZstdSession } = require('../../lib/codex-page-zstd-stream');
const { textProjection } = require('../../lib/codex-page-text-projection');
for (const compressed of [false, true]) test(`bounded record batches preserve offsets, unicode, malformed and unfinished records (${compressed})`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-batches-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'rollout-batches.jsonl' + (compressed ? '.zst' : ''));
  const row = text => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n';
  const a = Array.from({ length: 170 }, (_, n) => row(n + '中文🙂'.repeat(n === 70 ? 18000 : 5))).join('');
  const b = '{broken}\n' + row('after malformed') + row('unfinished').trimEnd();
  await fs.writeFile(filePath, compressed ? Buffer.concat([zstdCompressSync(a), zstdCompressSync(b)]) : a + b);
  const source = { filePath, canonicalRoot: root }, options = { allowPlain: true, projectConversation: true, projectionOptions: n => textProjection(n, '中文') };
  const read = async batched => {
    const stream = await createZstdSession(source, options), records = []; let batches = 0;
    try {
      if (batched) for await (const batch of stream.rawRecordBatches()) { assert.ok(batch.length > 0 && batch.length <= 64); records.push(...batch); batches++; }
      else for await (const r of stream.rawRecords()) records.push(r);
      return { records: JSON.parse(JSON.stringify(records)), batches };
    } finally { await stream.close(); }
  };
  const single = await read(false), batched = await read(true);
  assert.deepEqual(batched.records, single.records);
  assert.ok(batched.batches < single.records.length / 2);
  assert.equal(batched.records.at(-1).terminated, false);
  assert.equal(batched.records.at(-3).malformed, true);
});
