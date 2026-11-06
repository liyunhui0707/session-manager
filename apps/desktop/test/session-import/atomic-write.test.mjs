import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTempVault, cleanupTempVault } from './helpers.mjs';
import {
  writeAtomically,
  __testHooks,
} from '../../tools/session-import/lib/atomic-write.mjs';

test('atomic-write: success leaves no .tmp files behind', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const dest = path.join(tmp, 'out.md');
  await writeAtomically(dest, 'hello\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello\n');
  const entries = fs.readdirSync(tmp);
  for (const entry of entries) {
    assert.equal(/^\..*\.tmp$/.test(entry), false, `leftover tmp: ${entry}`);
  }
});

test('atomic-write: retries 4× on EEXIST then succeeds on the 5th attempt', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const dest = path.join(tmp, 'out.md');

  __testHooks.forceEexistRemaining = 4;
  t.after(() => {
    __testHooks.forceEexistRemaining = 0;
  });

  await writeAtomically(dest, 'content\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'content\n');
  assert.equal(
    __testHooks.forceEexistRemaining,
    0,
    'all 4 simulated EEXIST attempts consumed',
  );
  const entries = fs.readdirSync(tmp);
  for (const entry of entries) {
    assert.equal(/^\..*\.tmp$/.test(entry), false, `leftover tmp: ${entry}`);
  }
});

test('atomic-write: throws after 5 EEXIST attempts', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));
  const dest = path.join(tmp, 'out.md');

  __testHooks.forceEexistRemaining = 5;
  t.after(() => {
    __testHooks.forceEexistRemaining = 0;
  });

  await assert.rejects(
    writeAtomically(dest, 'x'),
    /atomic write failed after 5 attempts/,
  );
  assert.equal(fs.existsSync(dest), false, 'no output written on failure');
});
