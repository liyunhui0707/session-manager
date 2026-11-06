import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_NOW,
  mkTempVault,
  cleanupTempVault,
  copyFixtureWithPinnedMtime,
} from './helpers.mjs';
import { runClaudeImport } from '../../tools/session-import/import-claude.mjs';
import { runCodexImport } from '../../tools/session-import/import-codex.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const CLAUDE_FIXTURE = path.join(
  FIXTURES,
  'claude/basic/test-project/00000000-0000-4000-8000-000000000001.jsonl',
);

function setupValidSource(tmp) {
  const srcRoot = path.join(tmp, 'source');
  const dest = path.join(
    srcRoot,
    'test-project',
    '00000000-0000-4000-8000-000000000001.jsonl',
  );
  copyFixtureWithPinnedMtime(CLAUDE_FIXTURE, dest);
  return srcRoot;
}

for (const segments of [['2026'], ['2026', '01'], ['2026', '01', '01']]) {
  test(`Codex output rejects a nested ${segments.join('/')} symlink before writing`, async (t) => {
    const tmp = fs.realpathSync(mkTempVault());
    t.after(() => cleanupTempVault(tmp));
    const sourceRoot = path.join(tmp, 'source', 'sessions');
    const filename = 'rollout-2026-01-01T00-00-00-019c5f21-83e1-72c2-a129-83fa090f4c41.jsonl';
    copyFixtureWithPinnedMtime(
      path.join(FIXTURES, 'codex/basic/2026/01/01', filename),
      path.join(sourceRoot, '2026/01/01', filename),
    );
    const outputBase = path.join(tmp, 'library', 'codex');
    const link = path.join(outputBase, ...segments);
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
    fs.symlinkSync(outside, link);

    const result = await runCodexImport({ sourceRoot, outputBase, maxBytes: 52428800, now: FIXED_NOW });

    assert.deepEqual(fs.readdirSync(outside), ['sentinel'], 'must not create directories or transcripts outside outputBase');
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
    assert.equal(result.imported, 0);
    assert.equal(result.errors, 1);
  });
}

test('output-root: refuses outputBase = /', async () => {
  await assert.rejects(
    runClaudeImport({
      sourceRoot: '/tmp',
      outputBase: '/',
      maxBytes: 1024,
      now: FIXED_NOW,
    }),
    /outputBase must not be/,
  );
});

test('output-root: refuses outputBase = $HOME', async () => {
  await assert.rejects(
    runClaudeImport({
      sourceRoot: '/tmp',
      outputBase: process.env.HOME,
      maxBytes: 1024,
      now: FIXED_NOW,
    }),
    /outputBase must not be/,
  );
});

test('output-root: refuses outputBase that is itself a symlink', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const srcRoot = setupValidSource(tmp);
  const real = path.join(tmp, 'real-output');
  fs.mkdirSync(real);
  const link = path.join(tmp, 'link-output');
  fs.symlinkSync(real, link);
  await assert.rejects(
    runClaudeImport({
      sourceRoot: srcRoot,
      outputBase: link,
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /outputBase exists as a symlink|output ancestor is a symlink/,
  );
});

test('output-root: refuses outputBase with intermediate-component symlink', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const srcRoot = setupValidSource(tmp);
  const realIntermediate = path.join(tmp, 'real-int');
  fs.mkdirSync(realIntermediate);
  const linkIntermediate = path.join(tmp, 'link-int');
  fs.symlinkSync(realIntermediate, linkIntermediate);
  const outBase = path.join(linkIntermediate, 'output');
  await assert.rejects(
    runClaudeImport({
      sourceRoot: srcRoot,
      outputBase: outBase,
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /output ancestor is a symlink/,
  );
});

test('output-root: refuses outputBase that is a regular file', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const srcRoot = setupValidSource(tmp);
  const outFile = path.join(tmp, 'regular-file');
  fs.writeFileSync(outFile, 'not a dir');
  await assert.rejects(
    runClaudeImport({
      sourceRoot: srcRoot,
      outputBase: outFile,
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /outputBase exists but is not a directory/,
  );
});
