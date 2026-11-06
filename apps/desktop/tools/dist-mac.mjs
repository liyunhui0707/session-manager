// Build only for the host architecture: the bundled C helper is host-native.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw Error('Distribution requires an Apple Silicon or Intel Mac');
}
if (process.argv.length !== 2) throw Error('Build on the target architecture; no cross-build arguments are accepted');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builder = path.join(root, 'node_modules/electron-builder/cli.js');
const result = spawnSync(process.execPath, [builder, '--mac', 'dir',
  `--${process.arch}`, '--publish', 'never',
  '--config.electronDist=node_modules/electron/dist'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Native macOS tools avoid extra archive/DMG helper downloads. Retain staging
// after failures for diagnosis; never remove arbitrary files as part of a build.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const app = path.join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${pkg.productName}.app`);
const prefix = path.join(root, 'dist', `AI-Session-Manager-${pkg.version}-mac-${process.arch}`);
for (const ext of ['dmg', 'zip']) {
  if (fs.existsSync(`${prefix}.${ext}`)) throw Error(`Artifact already exists: ${prefix}.${ext}; move the previous candidate aside before rebuilding`);
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-dmg-'));
fs.chmodSync(stage, 0o700);
const commands = [
  ['/usr/bin/ditto', [app, path.join(stage, `${pkg.productName}.app`)]],
  ['/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, `${prefix}.zip`]],
  ['/usr/bin/hdiutil', ['create', '-volname', pkg.productName, '-srcfolder', stage, '-format', 'UDZO', `${prefix}.dmg`]],
];
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
for (const [command, args] of commands) {
  const r = spawnSync(command, args, { stdio: 'inherit', timeout: 300000 });
  if (r.error || r.status !== 0) throw r.error || Error(`Packaging failed: ${command}`);
}
console.log(`Unsigned release artifacts: ${prefix}.{dmg,zip}`);
