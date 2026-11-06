import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { __testHooks } from '../../tools/session-import/lib/safe-read.mjs';
const require = createRequire(import.meta.url);
const { loadCodexFile, MAX_CODEX_BYTES } = require('../../lib/codex-file');
const record = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic hello' }] } });

async function fixture(t) {
  const dir = await fs.mkdtemp('/private/tmp/asm-codex-file-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout-synthetic.jsonl');
  await fs.writeFile(file, record + '\n');
  return { dir, file };
}

test('selected file returns only a basename, bounded bytes and structured conversation without writes', async t => {
  const { file } = await fixture(t);
  const before = await fs.stat(file);
  const result = await loadCodexFile(file);
  assert.deepEqual(Object.keys(result).sort(), ['conversation', 'name', 'sourceBytes']);
  assert.equal(result.name, 'rollout-synthetic.jsonl');
  assert.equal(result.sourceBytes, Buffer.byteLength(record + '\n'));
  assert.deepEqual(result.conversation.messages, [{ role: 'user', text: 'Synthetic hello' }]);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(file, 'utf8'), record + '\n');
});

test('rejects relative, wrong-name, missing and nonregular selections', async t => {
  const { dir } = await fixture(t);
  await fs.mkdir(path.join(dir, 'rollout-directory.jsonl'));
  for (const file of ['rollout-relative.jsonl', path.join(dir, 'config.jsonl'), path.join(dir, 'rollout-missing.jsonl'), path.join(dir, 'rollout-directory.jsonl')]) {
    await assert.rejects(loadCodexFile(file));
  }
});

test('rejects leaf and ancestor symlinks', async t => {
  const { dir, file } = await fixture(t);
  const leaf = path.join(dir, 'rollout-link.jsonl');
  await fs.symlink(file, leaf);
  await assert.rejects(loadCodexFile(leaf));
  await fs.symlink(dir, path.join(dir, 'alias'));
  await assert.rejects(loadCodexFile(path.join(dir, 'alias', path.basename(file))));
});

test('accepts exact 50 MiB input cap and rejects one byte beyond it', async t => {
  const { file } = await fixture(t);
  assert.equal(MAX_CODEX_BYTES, 50 * 1024 * 1024);
  await fs.writeFile(file, ' '.repeat(MAX_CODEX_BYTES));
  assert.equal((await loadCodexFile(file)).sourceBytes, MAX_CODEX_BYTES);
  await fs.appendFile(file, ' ');
  await assert.rejects(loadCodexFile(file), { code: 'OVER_CAP' });
});

test('Reload revalidates replacement; identity races and unavailable safe reads fail closed', async t => {
  const { dir, file } = await fixture(t);
  await loadCodexFile(file);
  const saved = path.join(dir, 'saved.jsonl');
  await fs.rename(file, saved);
  await fs.symlink(saved, file);
  await assert.rejects(loadCodexFile(file));
  await fs.unlink(file);
  await fs.rename(saved, file);
  __testHooks.betweenOpenAndStat = async () => {
    await fs.rename(file, saved);
    await fs.writeFile(file, record);
  };
  try { await assert.rejects(loadCodexFile(file), /identity mismatch/); }
  finally { __testHooks.betweenOpenAndStat = null; }
  const original = __testHooks.getONOFOLLOW;
  __testHooks.getONOFOLLOW = () => undefined;
  try { await assert.rejects(loadCodexFile(file), /unsupported/); }
  finally { __testHooks.getONOFOLLOW = original; }
});

test('noncanonical selection cannot hide a symlink ancestor behind dot-dot', async t => {
  const { dir, file } = await fixture(t);
  await fs.mkdir(path.join(dir, 'child'));
  await fs.symlink(path.join(dir, 'child'), path.join(dir, 'linked-child'));
  // path.join would normalize away the segment before the loader can reject it.
  const selection = dir + '/linked-child/../' + path.basename(file);
  await assert.rejects(loadCodexFile(selection));
});
