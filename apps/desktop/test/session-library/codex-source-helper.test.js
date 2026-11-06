'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const { scanCodexSourceTree } = require('../../lib/codex-source-traversal');

const execFileAsync = promisify(execFile);
const ID = '11111111-1111-4111-8111-111111111111';
const OUTSIDE_ID = '99999999-9999-4999-8999-999999999999';
const NAME = `rollout-2026-09-01T10-00-00-${ID}.jsonl`;
const OUTSIDE_NAME = `rollout-2026-09-01T10-00-00-${OUTSIDE_ID}.jsonl`;
let helperPath;

async function fixture(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-native-scan-'));
  const parent = await fs.realpath(created);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'selected');
  await fs.mkdir(path.join(root, 'sessions', '2026', '09', '01'), { recursive: true });
  return { parent, root };
}

test.before(async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-native-helper-'));
  helperPath = path.join(outputDirectory, 'codex-source-helper-test');
  await execFileAsync(process.execPath, [
    path.join(__dirname, '..', '..', 'tools', 'build-codex-source-helper.mjs'),
    '--test', '--output', helperPath,
  ]);
});

test('native helper returns metadata and optional index bytes without opening rollout bodies', async (t) => {
  const { root } = await fixture(t);
  const active = path.join(root, 'sessions', '2026', '09', '01', NAME);
  const archived = path.join(root, 'archived_sessions', 'project',
    `rollout-2026-08-01T10-00-00-22222222-2222-4222-8222-222222222222.jsonl`);
  await fs.writeFile(active, 'body must remain unread');
  await fs.chmod(active, 0o000);
  await fs.mkdir(path.dirname(archived), { recursive: true });
  await fs.writeFile(archived, 'archived body must remain unread');
  await fs.chmod(archived, 0o000);
  await fs.writeFile(path.join(root, 'session_index.jsonl'), '{"synthetic":true}\n');

  const result = await scanCodexSourceTree(root, { helperPath, platform: 'darwin' });

  assert.equal(result.layout, 'full');
  assert.deepEqual(result.candidates.map(({ area, fileName }) => ({ area, fileName })), [
    { area: 'active', fileName: NAME },
    { area: 'archive', fileName: path.basename(archived) },
  ]);
  assert.equal(result.indexContent, '{"synthetic":true}\n');
  assert.ok(result.helperPeakRssBytes > 0);
});

test('optional index access failure keeps browsing available and reports one index error', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'sessions', '2026', '09', '01', NAME), 'synthetic');
  const index = path.join(root, 'session_index.jsonl');
  await fs.writeFile(index, '{"synthetic":true}\n');
  await fs.chmod(index, 0o000);

  const result = await scanCodexSourceTree(root, { helperPath, platform: 'darwin' });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.indexContent, '');
  assert.equal(result.diagnostics.indexErrors, 1);
});

test('skips have path-free, mutually exclusive reasons in active and archive scans', async t => {
  const { root } = await fixture(t);
  for (const area of ['sessions/2026/09/01', 'archived_sessions']) {
    const dir = path.join(root, area);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, NAME), 'synthetic');
    await fs.writeFile(path.join(dir, 'rollout-unsupported.jsonl.zst'), 'not a real compressed body; must never be opened');
    await fs.chmod(path.join(dir, 'rollout-unsupported.jsonl.zst'), 0o000);
    await fs.writeFile(path.join(dir, NAME.replace('.jsonl', '_' + OUTSIDE_ID + '.jsonl')), 'synthetic unsupported variant');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'synthetic unrelated');
    await fs.symlink(path.join(dir, NAME), path.join(dir, OUTSIDE_NAME));
  }
  await fs.mkdir(path.join(root, 'sessions', 'not-a-year'));
  const result = await scanCodexSourceTree(root, { helperPath, platform: 'darwin' });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.diagnostics.skipped, 9);
  assert.deepEqual(result.diagnostics.skippedReasons, { compressed: 2, unsupportedName: 2, layout: 1, unsafe: 2, other: 2 });
  assert.equal(JSON.stringify(result.diagnostics).includes(root), false);
  assert.equal(result.titleIndexState, 'missing');
});

test('optional index read failure does not abort an otherwise complete scan', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'sessions', '2026', '09', '01', NAME), 'synthetic');
  await fs.writeFile(path.join(root, 'session_index.jsonl'), '{"synthetic":true}\n');

  const result = await scanCodexSourceTree(root, {
    helperPath,
    platform: 'darwin',
    spawn(command, args, options) {
      return spawn(command, args, {
        ...options,
        env: { ...process.env, ASM_TEST_INDEX_READ_ERROR: '1' },
      });
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.indexContent, '');
  assert.equal(result.diagnostics.indexErrors, 1);
});

for (const relative of ['sessions/2026', 'archived_sessions/project']) {
  test(`native traversal remains anchored when a directory path is replaced: ${relative}`, async (t) => {
    const { parent, root } = await fixture(t);
    const target = path.join(root, relative);
    await fs.mkdir(target, { recursive: true });
    if (relative.startsWith('archived_sessions')) {
      await fs.writeFile(path.join(target,
        'rollout-2026-08-01T10-00-00-22222222-2222-4222-8222-222222222222.jsonl'), 'inside');
    }
    const outside = path.join(parent, 'outside');
    const outsideDirectory = relative.startsWith('sessions') ? path.join(outside, '09', '01') : outside;
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, OUTSIDE_NAME), 'outside');

    const result = await scanCodexSourceTree(root, {
      helperPath,
      platform: 'darwin',
      spawn(command, args, options) {
        return spawn(command, args, {
          ...options,
          env: {
            ...process.env,
            ASM_TEST_SWAP_TARGET: target,
            ASM_TEST_SWAP_OUTSIDE: outside,
          },
        });
      },
    });

    assert.equal(result.candidates.some(({ sessionId }) => sessionId === OUTSIDE_ID), false);
  });
}
