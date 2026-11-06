import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyMacBundle } from '../../apps/desktop/tools/verify-mac-bundle.mjs';

test('bundle verification accepts a sealed app and rejects altered resources or a missing helper', {
  skip: process.platform !== 'darwin',
}, () => {
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asm-sign-test-')), 'Synthetic.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources/bin'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents/MacOS/reader'));
  const helper = path.join(app, 'Contents/Resources/bin/codex-source-helper');
  fs.copyFileSync('/usr/bin/true', helper);
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>reader</string>
    <key>CFBundleIdentifier</key><string>test.synthetic.reader</string>
    <key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const body = path.join(app, 'Contents/Resources/body.txt');
  fs.writeFileSync(body, 'synthetic original');
  const sign = () => {
    for (const target of [helper, app].filter(p => fs.existsSync(p))) {
      const result = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', target], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  };
  sign();
  assert.doesNotThrow(() => verifyMacBundle(app));
  fs.writeFileSync(body, 'altered after signing');
  assert.throws(() => verifyMacBundle(app), /Bundle signature verification failed/);
  fs.writeFileSync(body, 'synthetic original');
  fs.renameSync(helper, path.join(path.dirname(app), 'helper-aside'));
  sign(); // A valid outer seal alone must not hide a missing native helper.
  assert.throws(() => verifyMacBundle(app), /Bundle signature verification failed: .*codex-source-helper/);
});
