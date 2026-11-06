'use strict';
// Synthetic only. Fixture generation and scanner measurement use separate fresh
// processes. RSS includes worker threads (same process), not the Electron app.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

async function main() {
  const [mode, filePath, size] = process.argv.slice(2);
  if (mode === 'fixture') {
    const record = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'Synthetic reading sample. 中文。 '.repeat(64) }] } }) + '\n';
    const block = Buffer.from(record.repeat(256));
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try { for (let n = 0; n < Number(size); n += block.length) fs.writeSync(fd, block); }
    finally { fs.closeSync(fd); }
    return;
  }
  if (mode === 'measure') {
    const { createCodexPagedReader } = require('../../tools/legacy-reader/codex-paged-reader');
    const reader = createCodexPagedReader();
    const baselineRssBytes = process.memoryUsage().rss;
    let sampledPeakRssBytes = baselineRssBytes;
    const sample = () => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); };
    const timer = setInterval(sample, 2);
    try {
      const start = performance.now();
      let session = await reader.open({ filePath, canonicalRoot: path.dirname(filePath), name: 'Synthetic long session' });
      const firstPageMs = performance.now() - start;
      const timings = [];
      for (let i = 0; i < 9; i++) {
        const began = performance.now();
        session = await reader.move(session.page.readerId, 'next');
        timings.push(performance.now() - began);
        assert.ok(session.conversation.messages.length <= 100);
        sample();
      }
      assert.equal(session.page.number, 10);
      const scannedBytes = session.page.scannedBytes;
      await reader.move(session.page.readerId, 'previous');
      const began = performance.now();
      const pending = reader.move(session.page.readerId, 'next');
      const rejection = pending.then(() => { throw Error('Cancellation unexpectedly completed'); }, e => {
        assert.equal(e.code, 'READ_CANCELLED'); return performance.now() - began;
      });
      await reader.cancel();
      const cancellationExitMs = performance.now() - began;
      const cancellationRejectMs = await rejection;
      sample();
      console.log(JSON.stringify({ node: process.version, fileBytes: session.sourceBytes,
        segmentsMeasured: 10, scannedBytes, baselineRssBytes, sampledPeakRssBytes,
        osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        retainedRssBytes: process.memoryUsage().rss, firstPageMs,
        nextPageMs: timings, cancellationRejectMs, cancellationExitMs }));
    } finally { clearInterval(timer); await reader.cancel(); }
    return;
  }
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Use Node 24');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asm-long-measure-')));
  const run = args => {
    const result = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 65536 });
    if (result.error || result.status !== 0 || result.signal) throw Error('Synthetic child failed');
    return result.stdout;
  };
  function fingerprint(file) {
    const stat = fs.statSync(file, { bigint: true });
    const hash = crypto.createHash('sha256'), buf = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r');
    try { let count; while ((count = fs.readSync(fd, buf))) hash.update(buf.subarray(0, count)); }
    finally { fs.closeSync(fd); }
    return JSON.stringify({ size: String(stat.size), mtime: String(stat.mtimeNs), mode: String(stat.mode), hash: hash.digest('hex') });
  }
  const results = [];
  for (const mib of [64, 256, 1024]) {
    const file = path.join(root, `rollout-synthetic-${mib}.jsonl`);
    run(['fixture', file, String(mib * 1024 * 1024)]);
    const before = fingerprint(file);
    const result = JSON.parse(run(['measure', file]));
    result.readOnlyVerified = before === fingerprint(file);
    assert.equal(result.readOnlyVerified, true);
    results.push(result);
  }
  const report = { scope: 'Fresh Node process plus worker threads; first 10 segments, back navigation and cancellation; not whole-app memory or a full-file traversal.', results };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence: root, ...report }, null, 2));
}
main().catch(() => { console.error('Synthetic long-session measurement failed'); process.exitCode = 1; });
