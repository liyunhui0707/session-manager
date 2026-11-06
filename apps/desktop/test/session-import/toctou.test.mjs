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
const POSIX = process.platform !== 'win32';

function setup(tmp) {
  const srcRoot = path.join(tmp, 'source');
  const outBase = path.join(tmp, 'output');
  const dest = path.join(
    srcRoot,
    'test-project',
    '00000000-0000-4000-8000-000000000001.jsonl',
  );
  copyFixtureWithPinnedMtime(CLAUDE_FIXTURE, dest);
  return { srcRoot, outBase, dest };
}

test('toctou A: symlink swap between lstat and open is caught (O_NOFOLLOW)', async (t) => {
  if (!POSIX) {
    t.skip('Windows: symlink creation requires admin');
    return;
  }
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const { srcRoot, outBase, dest } = setup(tmp);
  const outsideTarget = path.join(tmp, 'outside-target.txt');
  fs.writeFileSync(outsideTarget, 'outside payload');

  const originalHook = __testHooks.beforeOpen;
  __testHooks.beforeOpen = async (filePath) => {
    fs.unlinkSync(filePath);
    fs.symlinkSync(outsideTarget, filePath);
  };
  t.after(() => {
    __testHooks.beforeOpen = originalHook;
  });

  const result = await runClaudeImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  });
  assert.equal(result.imported, 0, 'no import');
  assert.ok(result.errors + result.skipped >= 1, 'file was rejected');
  const outFile = path.join(
    outBase,
    'test-project',
    '00000000-0000-4000-8000-000000000001.md',
  );
  assert.equal(fs.existsSync(outFile), false, 'no .md written');
});

test('toctou B: regular-file swap inside sourceRoot is caught by dev/ino', async (t) => {
  if (!POSIX) {
    t.skip('Windows: setup needs symlink-free swap; covered upstream');
    return;
  }
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const { srcRoot, outBase, dest } = setup(tmp);
  const swapFile = path.join(srcRoot, 'test-project', 'swap.jsonl');
  fs.writeFileSync(swapFile, '{}\n');

  const originalHook = __testHooks.betweenOpenAndStat;
  __testHooks.betweenOpenAndStat = async (filePath) => {
    fs.unlinkSync(filePath);
    fs.renameSync(swapFile, filePath);
  };
  t.after(() => {
    __testHooks.betweenOpenAndStat = originalHook;
  });

  const result = await runClaudeImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  });
  assert.equal(result.imported, 0, 'no import despite same path');
  assert.ok(result.errors + result.skipped >= 1, 'file was rejected by dev/ino guard');
});
