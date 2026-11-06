import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw Error('macOS is required to build the application icon');
const iconset = path.join(root, 'build', 'app.iconset');
const builder = path.join(root, 'build', 'icon-builder');
mkdirSync(iconset, { recursive: true });
for (const [command, args] of [
  ['/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', path.join(root, 'tools/build-app-icon.m'), '-o', builder]],
  [builder, [iconset]],
  ['/usr/bin/iconutil', ['-c', 'icns', '-o', path.join(root, 'build/app.icns'), iconset]],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || Error(`Icon build failed: ${command}`);
}
