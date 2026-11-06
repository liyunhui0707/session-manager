'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanCodexSource } = require('../../lib/codex-source-catalog');

const IDS = {
  first: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222',
};

test('active-only presentation removes archived sessions and restores them after an external unarchive', async t => {
  const root = await tempRoot(t);
  const active = await syntheticRollout(root, 'sessions/2026/09/01', IDS.first);
  const archived = await syntheticRollout(root, 'archived_sessions', IDS.second);
  assert.equal((await scanCodexSource(root, { activeOnly: true })).entries.length, 1);
  const moved = path.join(path.dirname(active), path.basename(archived));
  await fs.rename(archived, moved);
  assert.equal((await scanCodexSource(root, { activeOnly: true })).entries.length, 2);
  await fs.rename(active, path.join(root, 'archived_sessions', path.basename(active)));
  const next = await scanCodexSource(root, { activeOnly: true });
  assert.deepEqual(next.entries.map(e => e.sessionId), [IDS.second]);
});

function nativeMetadata(layout, candidates, options = {}) {
  return {
    layout,
    candidates,
    indexContent: options.indexContent || '',
    diagnostics: options.diagnostics || { skipped: 0, errors: 0, indexErrors: 0 },
    visited: candidates.length,
    helperPeakRssBytes: 4096,
  };
}

function rollout(id, stamp = '2026-09-01T10-00-00') {
  return `rollout-${stamp}-${id}.jsonl`;
}

async function tempRoot(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-catalog-'));
  const root = await fs.realpath(created);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function syntheticRollout(root, relative, id, options = {}) {
  const file = path.join(root, relative, rollout(id, options.stamp));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, options.body || '{"synthetic":true}\n');
  if (options.mtime) await fs.utimes(file, options.mtime, options.mtime);
  return file;
}

test('catalog policy consumes native relative metadata and performs no pathname traversal', async () => {
  const calls = [];
  const root = '/synthetic/canonical';
  const result = await scanCodexSource(root, {
    fsApi: {
      async lstat(candidate) { calls.push(['lstat', candidate]); return { isSymbolicLink: () => false, isDirectory: () => true }; },
      async realpath(candidate) { calls.push(['realpath', candidate]); return candidate; },
      async readdir(candidate) { calls.push(['readdir', candidate]); throw new Error('must not enumerate in JavaScript'); },
    },
    scanTree: async (canonicalRoot) => {
      assert.equal(canonicalRoot, root);
      return nativeMetadata('active-only', [{
        relativePath: `2026/09/01/${rollout(IDS.first)}`,
        fileName: rollout(IDS.first), sessionId: IDS.first,
        updatedAt: 1000, bytes: 12, area: 'active',
      }]);
    },
    makeOpaqueId: () => 'opaque-native',
  });

  assert.equal(result.entries[0].entryId, 'opaque-native');
  assert.equal(result.entries[0].filePath, path.join(root, '2026/09/01', rollout(IDS.first)));
  assert.deepEqual(calls.map(([operation]) => operation), ['lstat', 'realpath']);
});

test('full-root scan returns active/archive metadata, bounded titles, and active-wins duplicates', async (t) => {
  const root = await tempRoot(t);
  const older = new Date('2026-09-01T00:00:00Z');
  const newer = new Date('2026-09-02T00:00:00Z');
  await syntheticRollout(root, 'sessions/2026/09/01', IDS.first, { mtime: newer });
  await syntheticRollout(root, 'archived_sessions/project-a', IDS.first, { stamp: '2026-08-01T10-00-00', mtime: older });
  await syntheticRollout(root, 'archived_sessions/project-b', IDS.second, { mtime: older });
  await fs.writeFile(path.join(root, 'session_index.jsonl'), [
    JSON.stringify({ id: IDS.first, thread_name: '  Active\u0000 title  ' }),
    '{ malformed',
  ].join('\n'));

  const result = await scanCodexSource(root, { makeOpaqueId: (() => { let n = 0; return () => `entry-${++n}`; })() });

  assert.equal(result.layout, 'full');
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map(({ sessionId, area }) => ({ sessionId, area })), [
    { sessionId: IDS.first, area: 'active' },
    { sessionId: IDS.second, area: 'archive' },
  ]);
  assert.equal(result.entries[0].title, 'Active title');
  assert.equal(result.diagnostics.duplicates, 1);
  assert.equal(result.diagnostics.indexErrors, 1);
  assert.match(result.sourceId, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(result.publicCatalog).includes(root), false);
});

test('active-only scan stays inside the selected root and never opens rollout bodies', async (t) => {
  const root = await tempRoot(t);
  const outside = path.join(path.dirname(root), 'not-selected');
  await syntheticRollout(root, '2026/09/01', IDS.first);
  const touched = [];
  const fsApi = {
    lstat: async (candidate) => { touched.push(['lstat', candidate]); return fs.lstat(candidate); },
    realpath: async (candidate) => { touched.push(['realpath', candidate]); return fs.realpath(candidate); },
    readdir: async (candidate) => { touched.push(['readdir', candidate]); return fs.readdir(candidate); },
  };

  const result = await scanCodexSource(root, { fsApi, makeOpaqueId: () => 'opaque-only' });

  assert.equal(result.layout, 'active-only');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].entryId, 'opaque-only');
  assert.equal(touched.some(([, candidate]) => candidate === outside || candidate.startsWith(outside + path.sep)), false);
  assert.deepEqual(new Set(touched.map(([operation]) => operation)), new Set(['lstat', 'realpath']));
});

test('last valid rename survives malformed index metadata and Rescan adopts a later valid rename', async t => {
  const root = await tempRoot(t);
  await syntheticRollout(root, 'sessions/2026/09/01', IDS.first);
  const index = path.join(root, 'session_index.jsonl');
  await fs.writeFile(index, [
    { id: IDS.first, thread_name: 'First name' },
    { id: IDS.first, thread_name: 'Renamed conversation' },
    { id: IDS.first, unrelated: 'invalid optional metadata' },
  ].map(JSON.stringify).join('\n') + '\n');
  const before = await scanCodexSource(root);
  assert.equal(before.entries[0].title, 'Renamed conversation');
  assert.equal(before.diagnostics.indexErrors, 1);
  assert.equal(before.diagnostics.named, 1);
  assert.equal(before.publicCatalog.titleIndexState, 'loaded');
  await fs.appendFile(index, JSON.stringify({ id: IDS.first, thread_name: 'Latest name' }) + '\n');
  const after = await scanCodexSource(root);
  assert.equal(after.entries[0].title, 'Latest name');
  assert.equal(after.entries[0].sessionId, before.entries[0].sessionId);
  const active = await scanCodexSource(path.join(root, 'sessions'));
  assert.equal(active.publicCatalog.titleIndexState, 'not-selected');
  assert.equal(active.diagnostics.named, 0);
  assert.equal(active.entries[0].title, IDS.first.slice(0, 8));
});

test('scanner skips symlinks, invalid names, and can cancel without returning a partial catalog', async (t) => {
  const root = await tempRoot(t);
  const valid = await syntheticRollout(root, '2026/09/01', IDS.first);
  await fs.symlink(valid, path.join(path.dirname(valid), rollout(IDS.second)));
  await fs.writeFile(path.join(path.dirname(valid), 'notes.jsonl'), 'ignored');

  const scanned = await scanCodexSource(root);
  assert.equal(scanned.entries.length, 1);
  assert.equal(scanned.diagnostics.skipped, 2);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanCodexSource(root, { signal: controller.signal }), (error) => error.code === 'SCAN_CANCELLED');
});

test('full-root detection does not enumerate unrelated root entries', async (t) => {
  const root = await tempRoot(t);
  await syntheticRollout(root, 'sessions/2026/09/01', IDS.first);
  await fs.writeFile(path.join(root, 'auth.json'), 'synthetic secret-shaped data');
  const rootReads = [];
  const fsApi = {
    lstat: fs.lstat.bind(fs),
    realpath: fs.realpath.bind(fs),
    readdir: async (candidate) => {
      if (candidate === root) rootReads.push(candidate);
      return fs.readdir(candidate);
    },
  };

  const result = await scanCodexSource(root, { fsApi });
  assert.equal(result.layout, 'full');
  assert.deepEqual(rootReads, []);
});

test('generated 100, 1,000, and 10,000-session catalogs use metadata operations only', async (t) => {
  for (const count of [100, 1000, 10000]) {
    await t.test(String(count), async () => {
      const root = '/synthetic';
      const candidates = Array.from({ length: count }, (_, index) => {
        const fileName = rollout(`aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`);
        return { relativePath: `2026/09/01/${fileName}`, fileName,
          sessionId: fileName.match(/([0-9a-f-]{36})\.jsonl$/)[1], updatedAt: 1, bytes: 1, area: 'active' };
      });
      const fsApi = {
        async realpath(candidate) { return candidate; },
        async lstat() { return { isSymbolicLink: () => false, isDirectory: () => true }; },
      };
      let next = 0;
      const result = await scanCodexSource(root, {
        fsApi,
        scanTree: async () => nativeMetadata('active-only', candidates),
        makeOpaqueId: () => `opaque-${++next}`,
      });
      assert.equal(result.entries.length, count);
      assert.equal(result.diagnostics.errors, 0);
    });
  }
});

test('active presentation hides exact Guardian review titles using index metadata only and follows renames', async t => {
  const root = await tempRoot(t);
  await syntheticRollout(root, 'sessions/2026/09/01', IDS.first);
  await syntheticRollout(root, 'sessions/2026/09/01', IDS.second);
  const index = path.join(root, 'session_index.jsonl');
  await fs.writeFile(index, [
    { id: IDS.first, thread_name: 'Guardian review' },
    { id: IDS.second, thread_name: 'My Guardian review project' },
  ].map(JSON.stringify).join('\n'));
  const result = await scanCodexSource(root, { activeOnly: true });
  assert.deepEqual(result.entries.map(e => e.sessionId), [IDS.second]);
  assert.equal(result.diagnostics.hiddenReviews, 1);
  assert.equal(result.diagnostics.named, 1);
  // Generic catalog/standalone file inspection remains available; no source is removed.
  assert.equal((await scanCodexSource(root)).entries.length, 2);
  await fs.appendFile(index, '\n' + JSON.stringify({ id: IDS.first, thread_name: 'My conversation' }));
  assert.equal((await scanCodexSource(root, { activeOnly: true })).entries.length, 2);
});
