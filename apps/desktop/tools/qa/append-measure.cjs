'use strict';
// Synthetic-only append benchmark. Parent writes fixtures; each measurement
// runs in a fresh Node process. Explicit fixture appends model CLI writes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const prompt = text => record('event_msg', { type: 'user_message', message: text });
const final = text => record('event_msg', { type: 'task_complete', last_agent_message: text });
const pair = prompt('Synthetic question 中文 ' + 'Readable text. '.repeat(128)) + final('Synthetic answer 中文 ' + 'Readable text. '.repeat(128));
const block = Buffer.from(pair.repeat(128));
async function digest(file) { const h = createHash('sha256'); for await (const bytes of fs.createReadStream(file)) h.update(bytes); return h; }
async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === 'measure') {
    const { createConversationReader } = require('../../lib/codex-page-reader-v2');
    const reader = createConversationReader(), source = { filePath: file, canonicalRoot: path.dirname(file), name: 'Synthetic append measurement' };
    let peakRssBytes = process.memoryUsage().rss;
    const timer = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 2);
    try {
      const initialBytes = fs.statSync(file).size;
      let at = performance.now(); const opened = await reader.open(source); const initialMs = performance.now() - at;
      const originalHash = await digest(file), before = originalHash.copy().digest('hex');
      const added = prompt('Newly appended question') + final('Newly appended final answer');
      fs.appendFileSync(file, added);
      const expected = originalHash.update(added).digest('hex');
      at = performance.now(); const updated = await reader.move(opened.page.readerId, 'latest'); const appendMs = performance.now() - at;
      const appendWork = reader.getReadWork();
      assert.equal(appendWork.incremental, true); assert.equal(appendWork.parsedRecords, 2);
      assert.equal(appendWork.verifiedPrefixBytes, initialBytes);
      assert.equal(updated.conversation.messages.at(-1).text, 'Newly appended final answer');
      const reference = createConversationReader();
      at = performance.now(); const full = await reference.open(source); const fullRereadMs = performance.now() - at;
      assert.deepEqual(updated.conversation, full.conversation); assert.equal(updated.page.pages, full.page.pages);
      await reference.close();
      assert.equal((await digest(file)).digest('hex'), expected);
      at = performance.now(); await reader.move(updated.page.readerId, 'latest'); const unchangedLatestMs = performance.now() - at;
      assert.equal(reader.getReadWork().parsedRecords, 0);
      peakRssBytes = Math.max(peakRssBytes, process.resourceUsage().maxRSS * 1024);
      console.log(JSON.stringify({ initialBytes, appendedBytes: Buffer.byteLength(added), initialMs, appendMs, fullRereadMs,
        unchangedLatestMs, appendWork, peakRssBytes, originalSha256: before, expectedSha256: expected, onlyFixtureMutation: true }));
    } finally { clearInterval(timer); await reader.close(); }
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asm-append-measure-'))), results = [];
  for (const mib of [64, 256, 1024]) {
    const target = path.join(root, `rollout-${mib}.jsonl`), fd = fs.openSync(target, 'wx', 0o600);
    let size = 0;
    try { while (size < mib * 1024 ** 2) size += fs.writeSync(fd, block); } finally { fs.closeSync(fd); }
    const child = spawnSync(process.execPath, [__filename, 'measure', target], { encoding: 'utf8', timeout: 180000, maxBuffer: 65536 });
    if (child.status !== 0 || child.error || child.signal) throw Error('Synthetic measurement failed: ' + child.stderr.slice(-1500));
    const result = JSON.parse(child.stdout); results.push(result); console.log(JSON.stringify(result));
    fs.unlinkSync(target); // exact synthetic fixture owned by this invocation
  }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ scope: 'Fresh Node 24 reader processes; one synthetic run per size. RSS includes worker threads, excludes Electron. Prefix bytes are hashed, not parsed again. Not a cold-disk or percentile guarantee.', results }, null, 2));
  console.log('Evidence: ' + root);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
