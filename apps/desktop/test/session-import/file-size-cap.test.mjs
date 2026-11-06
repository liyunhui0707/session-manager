import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../tools/session-import');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('file-size-cap: every importer-side .mjs is at most 300 lines', () => {
  const files = walk(ROOT);
  assert.ok(files.length > 0, 'expected at least one .mjs file');
  const offenders = [];
  for (const f of files) {
    const n = fs.readFileSync(f, 'utf8').split('\n').length;
    if (n > 300) offenders.push(`${path.relative(ROOT, f)}: ${n} lines`);
  }
  assert.deepEqual(offenders, [], 'no file may exceed 300 lines');
});
