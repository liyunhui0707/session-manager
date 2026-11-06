'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { zstdCompressSync } = require('node:zlib');
const { scanCodexSource } = require('../../lib/codex-source-catalog');
const { createBrowsingScanner } = require('../../lib/codex-page-browsing-scan');
const { createSessionSourceState } = require('../../lib/session-source-state');
const ids = Array.from({ length: 6 }, (_, n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`);
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-browsing-origin-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const active = path.join(root, 'sessions/2026/11/04'); await fs.mkdir(active, { recursive: true });
  const payloads = [{ source: { subagent: { other: 'guardian' } } }, { source: { internal: 'guardian' } },
    { thread_source: 'guardian_review' }, { source: 'cli' }, { source: 'cli' }, {}];
  const files = [];
  for (let n = 0; n < ids.length; n++) {
    const file = path.join(active, `rollout-2026-11-04T00-00-00-${ids[n]}.jsonl${n === 1 ? '.zst' : ''}`);
    const text = JSON.stringify({ type: 'session_meta', payload: { id: ids[n], ...payloads[n] } }) + '\n' +
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Guardian review risk_level is just text' } }) + '\n';
    await fs.writeFile(file, n === 1 ? zstdCompressSync(text) : text); files.push(file);
  }
  const index = path.join(root, 'session_index.jsonl');
  await fs.writeFile(index, JSON.stringify({ id: ids[1], thread_name: 'Renamed review' }) + '\n' +
    JSON.stringify({ id: ids[3], thread_name: 'Guardian review' }) + '\n');
  return { root, files, index };
}
test('production presentation hides named/unnamed structured reviews, retains normal IDs and title lookalikes, and caches only unchanged headers', async t => {
  const { root, files, index } = await setup(t);
  const before = await Promise.all([...files, index].map(p => fs.readFile(p)));
  const scan = createBrowsingScanner(scanCodexSource);
  const first = await scan(root);
  assert.deepEqual(new Set(first.entries.map(e => e.sessionId)), new Set(ids.slice(3)));
  assert.equal(first.diagnostics.hiddenReviews, 3);
  assert.equal(first.diagnostics.named, 1);
  assert.equal(first.diagnostics.originUnknown, 1);
  assert.equal(first.originMetrics.probed, 6);
  assert.equal(JSON.stringify(first.publicCatalog).includes(root), false);
  const second = await scan(root);
  assert.equal(second.originMetrics.probed, 0);
  assert.deepEqual(await Promise.all([...files, index].map(p => fs.readFile(p))), before);
  // A file rewrite must invalidate an earlier classification, even with the same ID.
  await fs.writeFile(files[0], JSON.stringify({ type: 'session_meta', payload: { id: ids[0], source: 'cli' } }) + '\n');
  const changed = await scan(root);
  assert.equal(changed.entries.some(e => e.sessionId === ids[0]), false);
  assert.equal(changed.diagnostics.hiddenEmpty, 1);
  await fs.appendFile(files[0], JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'New pending prompt' } }) + '\n');
  assert.equal((await scan(root)).entries.some(e => e.sessionId === ids[0]), true);
  assert.equal(changed.originMetrics.probed, 1);
  assert.equal(changed.diagnostics.hiddenReviews, 2);
});
test('cancelled provenance phase does not publish a partial replacement or poison the next scan', async t => {
  const { root } = await setup(t);
  const state = createSessionSourceState(() => true), scan = createBrowsingScanner(scanCodexSource);
  const old = await scan(root), token = state.beginFolderScan(root);
  state.commitFolderScan(token, old); state.finishFolderScan(token);
  const generation = state.getFolderCatalog().generation;
  const controller = new AbortController();
  const cancellingScan = createBrowsingScanner(async (...args) => {
    const catalog = await scanCodexSource(...args);
    setTimeout(() => controller.abort(), 1); return catalog;
  });
  await assert.rejects(cancellingScan(root, { signal: controller.signal }), { code: 'SCAN_CANCELLED' });
  assert.equal(state.getFolderCatalog().generation, generation);
  assert.equal((await cancellingScan(root)).entries.length, 3);
});

test('raw and compressed subagents are absent from the public catalog, including cached rescans', async t => {
  const { root, files } = await setup(t);
  const payloads = [{ source: { subagent: { thread_spawn: { parent_thread_id: ids[3], depth: 1 } } } },
    { source: { subagent: 'compact' } }, { thread_source: 'subagent' }];
  for (let i = 0; i < payloads.length; i++) {
    const text = JSON.stringify({ type: 'session_meta', payload: { id: ids[i], ...payloads[i] } }) + '\n';
    await fs.writeFile(files[i], i === 1 ? zstdCompressSync(text) : text);
  }
  const before = await Promise.all(files.map(p => fs.readFile(p)));
  const scan = createBrowsingScanner(scanCodexSource);
  for (let run = 0; run < 2; run++) {
    const result = await scan(root);
    assert.deepEqual(new Set(result.publicCatalog.entries.map(e => e.sessionId)), new Set(ids.slice(3)));
    assert.equal(result.publicCatalog.diagnostics.hiddenBackground, 3);
    assert.equal(result.diagnostics.hiddenReviews, 0);
    assert.equal(result.diagnostics.originUnknown, 1);
    assert.equal(result.originMetrics.probed, run === 0 ? 6 : 0);
  }
  assert.deepEqual(await Promise.all(files.map(p => fs.readFile(p))), before);
});
test('timeout or incomplete worker output rejects the whole presentation phase', async t => {
  const { root } = await setup(t);
  const workerPath = path.join(root, 'empty-worker.cjs');
  await fs.writeFile(workerPath, '');
  await assert.rejects(createBrowsingScanner(scanCodexSource, { workerPath })(root), { code: 'ORIGIN_FAILED' });
  await fs.writeFile(workerPath, 'setInterval(() => {}, 1000)');
  await assert.rejects(createBrowsingScanner(scanCodexSource, { workerPath, timeoutMs: 20 })(root), { code: 'ORIGIN_TIMEOUT' });
});

test('exec and MCP automation is excluded before public counts and cached rescans', async t => {
  const { root, files } = await setup(t);
  for (let i = 0; i < 2; i++) {
    const text = JSON.stringify({ type: 'session_meta', payload: { id: ids[i], source: i ? 'mcp' : 'exec', thread_source: 'user' } }) + '\n';
    await fs.writeFile(files[i], i ? zstdCompressSync(text) : text);
  }
  const scan = createBrowsingScanner(scanCodexSource);
  for (let i = 0; i < 2; i++) {
    const result = await scan(root);
    assert.deepEqual(new Set(result.publicCatalog.entries.map(e => e.sessionId)), new Set(ids.slice(3)));
    assert.equal(result.publicCatalog.diagnostics.hiddenAutomation, 2);
    assert.equal(result.diagnostics.hiddenReviews, 1);
    assert.equal(result.diagnostics.originUnknown, 1);
    assert.equal(result.originMetrics.probed, i ? 0 : 6);
  }
});
