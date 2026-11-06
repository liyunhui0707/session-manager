'use strict';
// Synthetic fixtures are generated in a completed process, then read in a fresh
// process. Measures the entire decoded transcript, not just the first segments.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { performance } = require('node:perf_hooks');
const record = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
  content: [{ type: 'input_text', text: 'Synthetic compressed conversation. 中文。 '.repeat(64) }] } }) + '\n';
const block = Buffer.from(record.repeat(256));
async function main() {
  const [mode, file, count] = process.argv.slice(2);
  if (mode === 'fixture') {
    const { createZstdCompress } = require('node:zlib');
    await pipeline(Readable.from((function* () { for (let i = 0; i < Number(count); i++) yield block; })()),
      createZstdCompress(), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    return;
  }
  if (mode === 'measure') {
    const { createCodexPagedReader } = require('../../tools/legacy-reader/codex-paged-reader');
    const reader = createCodexPagedReader();
    const baselineRssBytes = process.memoryUsage().rss;
    let peak = baselineRssBytes, messages = 0, pages = 0, maxNextMs = 0, totalNextMs = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
    try {
      const source = { filePath: file, canonicalRoot: path.dirname(file), name: 'Synthetic compressed' };
      const start = performance.now(); let page = await reader.open(source);
      const firstPageMs = performance.now() - start;
      for (;;) {
        pages++; messages += page.conversation.messages.length;
        assert.ok(page.conversation.messages.length <= 100);
        if (!page.page.hasNext) break;
        const at = performance.now(); page = await reader.move(page.page.readerId, 'next');
        const ms = performance.now() - at; totalNextMs += ms; maxNextMs = Math.max(maxNextMs, ms);
      }
      assert.equal(messages, Number(count) * 256);
      const fullReadMs = performance.now() - start;
      const retainedRssBytes = process.memoryUsage().rss;
      const at = performance.now();
      await reader.move(page.page.readerId, 'previous');
      const previousMs = performance.now() - at;
      const cancelledAt = performance.now();
      const pending = reader.move(page.page.readerId, 'next');
      const rejection = pending.then(() => { throw Error('cancel resolved'); }, error => {
        assert.equal(error.code, 'READ_CANCELLED'); return performance.now() - cancelledAt;
      });
      await reader.cancel(); const cancellationCloseMs = performance.now() - cancelledAt;
      const cancellationRejectMs = await rejection;
      peak = Math.max(peak, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
      console.log(JSON.stringify({ node: process.version, compressedBytes: fs.statSync(file).size,
        decodedBytes: Number(count) * block.length, messages, pages, baselineRssBytes, peakRssBytes: peak,
        retainedRssBytes, firstPageMs, fullReadMs, meanNextMs: totalNextMs / (pages - 1), maxNextMs,
        previousMs, cancellationRejectMs, cancellationCloseMs }));
    } finally { clearInterval(timer); await reader.close(); }
    return;
  }
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asm-zstd-measure-')));
  const run = args => {
    const r = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 65536 });
    if (r.status !== 0 || r.error || r.signal) throw Error('Synthetic child failed: ' + r.stderr.slice(-1000));
    return r.stdout;
  };
  const fingerprint = file => {
    const st = fs.statSync(file, { bigint: true });
    return JSON.stringify({ size: String(st.size), mode: String(st.mode), mtime: String(st.mtimeNs),
      hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  };
  const results = [];
  for (const size of [64, 256, 1024]) {
    const file = path.join(root, `rollout-${size}.jsonl.zst`), count = Math.ceil(size * 1024 * 1024 / block.length);
    run(['fixture', file, String(count)]);
    const before = fingerprint(file), names = fs.readdirSync(root).sort().join('\n');
    const result = JSON.parse(run(['measure', file, String(count)]));
    assert.equal(fingerprint(file), before); assert.equal(fs.readdirSync(root).sort().join('\n'), names);
    results.push({ ...result, readOnly: true });
    fs.unlinkSync(file); // only this script's temporary synthetic fixture
  }
  const report = { scope: 'One fresh Node run per size; RSS includes worker threads, not whole Electron', results };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence: root, ...report }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
