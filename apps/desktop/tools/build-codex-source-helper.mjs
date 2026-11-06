import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', 'native', 'codex-source-helper.c');
const outputFlag = process.argv.indexOf('--output');
const output = outputFlag === -1
  ? path.join(here, '..', 'build', 'native', 'codex-source-helper')
  : process.argv[outputFlag + 1];

if (process.platform !== 'darwin') throw new Error('POSIX helper build is supported on macOS only');
if (!output || !path.isAbsolute(output)) throw new Error('Helper output must be an absolute path');

await fs.mkdir(path.dirname(output), { recursive: true });
const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
if (!architecture) throw new Error(`Unsupported macOS architecture: ${process.arch}`);

const flags = [
  '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  '-mmacosx-version-min=12.0', '-arch', architecture,
];
if (process.argv.includes('--test')) flags.push('-DASM_TESTING=1');
flags.push(source, '-o', output);

await execFileAsync('clang', flags);
await fs.chmod(output, 0o755);
console.log(output);
