import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanCodexSource } = require('../../lib/codex-source-catalog');
const { loadCodexCatalogEntry, MAX_CODEX_BYTES } = require('../../lib/codex-file');
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NAME = `rollout-2026-09-01T10-00-00-${ID}.jsonl`;

async function fixture(t, body) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-folder-read-'));
  const root = await fs.realpath(created);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'sessions', '2026', '09', '01');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, NAME);
  await fs.writeFile(file, body);
  return { root, file };
}

test('catalog entry body loads through the hardened reader without changing source bytes or metadata', async (t) => {
  const body = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic only' }] } })}\n`;
  const { root, file } = await fixture(t, body);
  const before = await fs.stat(file);
  const catalog = await scanCodexSource(root);
  const loaded = await loadCodexCatalogEntry(catalog.entries[0]);
  const after = await fs.stat(file);

  assert.equal(loaded.name, ID.slice(0, 8));
  assert.equal(loaded.sourceBytes, Buffer.byteLength(body));
  assert.equal(loaded.conversation.messages[0].text, 'Synthetic only');
  assert.equal(after.size, before.size);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(file, 'utf8'), body);
});

test('catalog body load rejects containment escapes, symlink replacement, and files above 50 MiB', async (t) => {
  const { root, file } = await fixture(t, '{}\n');
  const catalog = await scanCodexSource(root);
  await assert.rejects(loadCodexCatalogEntry({ ...catalog.entries[0], filePath: path.join(path.dirname(root), NAME) }));

  await fs.unlink(file);
  const outside = path.join(root, 'outside.jsonl');
  await fs.writeFile(outside, '{}\n');
  await fs.symlink(outside, file);
  await assert.rejects(loadCodexCatalogEntry(catalog.entries[0]));

  await fs.unlink(file);
  await fs.writeFile(file, '');
  await fs.truncate(file, MAX_CODEX_BYTES + 1);
  await assert.rejects(loadCodexCatalogEntry(catalog.entries[0]), (error) => error.code === 'OVER_CAP');
});
