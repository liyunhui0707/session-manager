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
import { __testHooks } from '../../tools/session-import/lib/safe-read.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURE = path.join(
  __dirname,
  'fixtures/claude/basic/test-project/00000000-0000-4000-8000-000000000001.jsonl',
);

test('o-nofollow-availability: missing O_NOFOLLOW throws a clear error', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const srcRoot = path.join(tmp, 'source');
  const outBase = path.join(tmp, 'output');
  copyFixtureWithPinnedMtime(
    CLAUDE_FIXTURE,
    path.join(
      srcRoot,
      'test-project',
      '00000000-0000-4000-8000-000000000001.jsonl',
    ),
  );

  const originalGetONOFOLLOW = __testHooks.getONOFOLLOW;
  __testHooks.getONOFOLLOW = () => undefined;
  t.after(() => {
    __testHooks.getONOFOLLOW = originalGetONOFOLLOW;
  });

  await assert.rejects(
    runClaudeImport({
      sourceRoot: srcRoot,
      outputBase: outBase,
      maxBytes: 52428800,
      now: FIXED_NOW,
    }),
    /symlink-safe reads unsupported|O_NOFOLLOW/,
  );
});
