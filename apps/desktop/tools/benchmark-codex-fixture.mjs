import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COUNTS, workerMain } from './benchmark-codex-report.mjs';

export async function generateFixture(root, count) {
  if (!COUNTS.includes(count) || !path.isAbsolute(root)) throw new Error('Invalid fixture request');
  // The coordinator owns the parent; refusing an existing root prevents accidental replacement.
  await fs.mkdir(root);
  const directory = path.join(root, 'sessions', '2026', '01', '01');
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < count; index++) {
    const id = `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`;
    await fs.writeFile(path.join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`), '', { flag: 'wx' });
  }
  return count;
}

// Only the coordinator/test uses this, outside every measured process. Do not follow links.
export async function snapshotFixture(root) {
  const rows = [];
  async function visit(relative) {
    const target = path.join(root, relative);
    const stat = await fs.lstat(target, { bigint: true });
    const row = { relative, mode: String(stat.mode), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
    if (stat.isSymbolicLink()) {
      rows.push({ ...row, type: 'link', target: await fs.readlink(target) });
    } else if (stat.isDirectory()) {
      const names = (await fs.readdir(target)).sort();
      rows.push({ ...row, type: 'directory', names });
      for (const name of names) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      rows.push({ ...row, type: 'file', sha256: createHash('sha256').update(await fs.readFile(target)).digest('hex') });
    } else throw new Error('Invalid fixture object');
  }
  await visit('');
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await workerMain(['generate'], async ({ root, count }) => ({ files: await generateFixture(root, count) }));
}
