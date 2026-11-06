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
const POSIX = process.platform !== 'win32';

test('mode: output file is 0o600 and created dirs are 0o700 (POSIX only)', async (t) => {
  if (!POSIX) {
    t.skip('Windows: POSIX file mode not applicable');
    return;
  }
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));

  const srcRoot = path.join(tmp, 'source');
  const outBase = path.join(tmp, 'output');
  const fixtureDest = path.join(
    srcRoot,
    'test-project',
    '00000000-0000-4000-8000-000000000001.jsonl',
  );
  copyFixtureWithPinnedMtime(CLAUDE_FIXTURE, fixtureDest);

  const result = await runClaudeImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  });
  assert.equal(result.imported, 1);

  const outFile = path.join(
    outBase,
    'test-project',
    '00000000-0000-4000-8000-000000000001.md',
  );
  const fileStat = fs.statSync(outFile);
  assert.equal(fileStat.mode & 0o777, 0o600, 'output file should be 0o600');

  const outBaseStat = fs.statSync(outBase);
  assert.equal(outBaseStat.mode & 0o777, 0o700, 'outputBase should be 0o700');

  const projOutStat = fs.statSync(path.join(outBase, 'test-project'));
  assert.equal(projOutStat.mode & 0o777, 0o700, 'project subdir should be 0o700');
});

test('mode: pre-existing outputBase parent is NOT chmod-modified', async (t) => {
  if (!POSIX) {
    t.skip('Windows: POSIX file mode not applicable');
    return;
  }
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));

  const srcRoot = path.join(tmp, 'source');
  const fixtureDest = path.join(
    srcRoot,
    'test-project',
    '00000000-0000-4000-8000-000000000001.jsonl',
  );
  copyFixtureWithPinnedMtime(CLAUDE_FIXTURE, fixtureDest);

  const preExisting = path.join(tmp, 'pre-existing');
  fs.mkdirSync(preExisting, { mode: 0o755 });
  const outBase = path.join(preExisting, 'output');

  const before = fs.statSync(preExisting).mode & 0o777;
  await runClaudeImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  });
  const after = fs.statSync(preExisting).mode & 0o777;
  assert.equal(after, before, 'pre-existing parent mode unchanged');
});
