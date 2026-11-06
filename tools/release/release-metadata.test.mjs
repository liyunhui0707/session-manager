import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { releaseFiles, checksums } from './release-metadata.mjs';

test('release manifest includes only exact-version, exact-architecture artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-release-test-'));
  for (const extension of ['dmg', 'zip']) fs.writeFileSync(path.join(dir, `AI-Session-Manager-0.10.1-mac-arm64.${extension}`), 'synthetic');
  fs.writeFileSync(path.join(dir, 'unrelated.zip'), 'private-placeholder');
  const files = releaseFiles(dir, '0.10.1', 'arm64');
  assert.equal(files.length, 2);
  const digest = crypto.createHash('sha256').update('synthetic').digest('hex');
  assert.equal(await checksums(files), files.map(f => `${digest}  ${f.name}\n`).join(''));
  assert.throws(() => releaseFiles(dir, '../escape', 'arm64'));
  assert.throws(() => releaseFiles(dir, '0.10.1', 'x64'));
  assert.throws(() => releaseFiles(dir, '0.10.1', '../arm64'));
});

test('empty files and symlinks cannot become release assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-release-test-'));
  const target = path.join(dir, 'AI-Session-Manager-0.10.1-mac-arm64.dmg');
  fs.writeFileSync(target, '');
  assert.throws(() => releaseFiles(dir, '0.10.1', 'arm64'), /nonempty/);
  fs.renameSync(target, target + '.old');
  fs.symlinkSync(target + '.old', target);
  assert.throws(() => releaseFiles(dir, '0.10.1', 'arm64'), /nonempty/);
});
