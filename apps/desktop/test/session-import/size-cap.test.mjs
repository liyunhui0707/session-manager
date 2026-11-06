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
const CLAUDE_FIXTURE = path.join(
  __dirname,
  'fixtures/claude/basic/test-project/00000000-0000-4000-8000-000000000001.jsonl',
);

test('size-cap: file > maxBytes is skipped (count incremented, no output, no throw)', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const srcRoot = path.join(tmp, 'source');
  const outBase = path.join(tmp, 'output');
  const dest = path.join(
    srcRoot,
    'test-project',
    '00000000-0000-4000-8000-000000000001.jsonl',
  );
  copyFixtureWithPinnedMtime(CLAUDE_FIXTURE, dest);
  const realSize = fs.statSync(dest).size;

  const result = await runClaudeImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: Math.max(1, realSize - 1),
    now: FIXED_NOW,
  });

  assert.equal(result.imported, 0, 'no file imported');
  assert.equal(result.skipped, 1, 'one skipped (size-cap)');
  assert.equal(result.errors, 0);
  const outFile = path.join(
    outBase,
    'test-project',
    '00000000-0000-4000-8000-000000000001.md',
  );
  assert.equal(fs.existsSync(outFile), false, 'no .md output written');
});
