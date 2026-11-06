import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// A linker signature on Electron's executable is not a sealed application.
// Verify the assembled bundle and the helper outside the Frameworks directory.
export function verifyMacBundle(app) {
  for (const target of [app, path.join(app, 'Contents/Resources/bin/codex-source-helper')]) {
    const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], {
      encoding: 'utf8', timeout: 120000,
    });
    if (result.error || result.status !== 0) {
      throw Error(`Bundle signature verification failed: ${target}\n${result.stderr || result.error || ''}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw Error('Bundle verification requires macOS');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const app = process.argv[2] || path.join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${pkg.productName}.app`);
  verifyMacBundle(app);
  console.log('Bundle signatures verified (not a notarization or Gatekeeper acceptance check).');
}
