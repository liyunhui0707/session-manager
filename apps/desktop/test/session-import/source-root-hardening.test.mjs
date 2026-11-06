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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const CLAUDE_FIXTURE = path.join(
  FIXTURES,
  'claude/basic/test-project/00000000-0000-4000-8000-000000000001.jsonl',
);

test('source-root: missing sourceRoot returns no-source (not throw)', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const srcRoot = path.join(tmp, 'does-not-exist');
  const outBase = path.join(tmp, 'output');
  const result = await runClaudeImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  });
  assert.equal(result.note, 'no-source');
  assert.equal(result.imported, 0);
  assert.equal(fs.existsSync(outBase), false, 'no output dir created');
});

test('source-root: symlink as sourceRoot is rejected', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const real = path.join(tmp, 'real-src');
  fs.mkdirSync(real);
  const link = path.join(tmp, 'link-src');
  fs.symlinkSync(real, link);
  await assert.rejects(
    runClaudeImport({
      sourceRoot: link,
      outputBase: path.join(tmp, 'output'),
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /sourceRoot must not be a symlink/,
  );
});

test('source-root: regular file as sourceRoot is rejected', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const filePath = path.join(tmp, 'a-file');
  fs.writeFileSync(filePath, 'data');
  await assert.rejects(
    runClaudeImport({
      sourceRoot: filePath,
      outputBase: path.join(tmp, 'output'),
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /sourceRoot must be a directory/,
  );
});

test('source-root: $HOME as sourceRoot is rejected', async () => {
  await assert.rejects(
    runClaudeImport({
      sourceRoot: process.env.HOME,
      outputBase: '/tmp/never-created',
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /sourceRoot must not be/,
  );
});

test('source-root: production-like .claude/projects (under tmp) is accepted', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const srcRoot = path.join(tmp, '.claude/projects');
  const dest = path.join(
    srcRoot,
    'test-project',
    '00000000-0000-4000-8000-000000000001.jsonl',
  );
  copyFixtureWithPinnedMtime(CLAUDE_FIXTURE, dest);
  const outBase = path.join(tmp, 'output');
  const result = await runClaudeImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  });
  assert.equal(result.imported, 1, 'hidden-agent-container parent is allowed');
});

test('source-root: empty string sourceRoot throws', async () => {
  await assert.rejects(
    runClaudeImport({
      sourceRoot: '',
      outputBase: '/tmp/x',
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /sourceRoot must be a non-empty string/,
  );
});
