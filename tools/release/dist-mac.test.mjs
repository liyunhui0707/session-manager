import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../apps/desktop/tools/dist-mac.mjs', import.meta.url));
function fixture(installFailure = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-dist-test-'));
  for (const dir of ['tools', 'node_modules/electron', 'node_modules/electron-builder', 'dist']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.copyFileSync(script, path.join(root, 'tools/dist-mac.mjs'));
  const verifier = path.join(path.dirname(script), 'verify-mac-bundle.mjs');
  if (fs.existsSync(verifier)) fs.copyFileSync(verifier, path.join(root, 'tools/verify-mac-bundle.mjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.1', productName: 'Synthetic Reader' }));
  fs.writeFileSync(path.join(root, 'node_modules/electron/install.js'), installFailure
    ? 'process.exit(72);'
    : `require('node:fs').mkdirSync('node_modules/electron/dist');`);
  // Stop before platform archiving tools; the real packaging entry point must
  // prepare a fresh runtime before invoking the builder.
  fs.writeFileSync(path.join(root, 'node_modules/electron-builder/cli.js'), `
    const fs = require('node:fs');
    fs.writeFileSync('builder-invoked', 'yes');
    process.exit(fs.existsSync('node_modules/electron/dist') ? 73 : 74);
  `);
  return root;
}
function run(root, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'tools/dist-mac.mjs'), ...args], { encoding: 'utf8' });
}
const mac = { skip: process.platform !== 'darwin' };
test('fresh distribution prepares Electron before running the builder', mac, () => {
  const root = fixture();
  assert.equal(run(root).status, 73);
  assert.ok(fs.existsSync(path.join(root, 'node_modules/electron/dist')));
});
test('runtime installation failure stops packaging', mac, () => {
  const root = fixture(true);
  assert.equal(run(root).status, 72);
  assert.equal(fs.existsSync(path.join(root, 'builder-invoked')), false);
});
test('existing release assets are refused before any build work', mac, () => {
  const root = fixture();
  const asset = path.join(root, 'dist', `AI-Session-Manager-0.0.1-mac-${process.arch}.zip`);
  fs.writeFileSync(asset, 'previous candidate');
  const result = run(root);
  assert.match(result.stderr, /Artifact already exists/);
  assert.equal(fs.readFileSync(asset, 'utf8'), 'previous candidate');
  assert.equal(fs.existsSync(path.join(root, 'builder-invoked')), false);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/electron/dist')), false);
});
test('cross-build arguments cannot start runtime preparation', mac, () => {
  const root = fixture();
  assert.match(run(root, ['--x64']).stderr, /no cross-build arguments/);
  assert.equal(fs.existsSync(path.join(root, 'builder-invoked')), false);
});
test('a successful builder with an invalid app signature cannot produce release archives', mac, () => {
  const root = fixture();
  const app = path.join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Synthetic Reader.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources'));
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents/MacOS/reader'));
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>reader</string>
    <key>CFBundleIdentifier</key><string>test.synthetic.reader</string>
    <key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  fs.writeFileSync(path.join(app, 'Contents/Resources/body.txt'), 'synthetic');
  fs.writeFileSync(path.join(root, 'node_modules/electron-builder/cli.js'), 'process.exit(0);');
  const result = run(root);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Bundle signature verification failed/);
  for (const extension of ['zip', 'dmg']) {
    assert.equal(fs.existsSync(path.join(root, 'dist', `AI-Session-Manager-0.0.1-mac-${process.arch}.${extension}`)), false);
  }
});
