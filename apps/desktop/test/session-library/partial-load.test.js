'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadSessionLibrary, MAX_SESSION_BYTES } = require('../../lib/session-library');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-partial-load-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const agent of ['codex', 'claude-code']) {
    await fs.mkdir(path.join(root, agent));
    await fs.writeFile(path.join(root, agent, 'good.md'), '## User\nSynthetic message\n', { mode: 0o600 });
  }
  const bad = path.join(root, 'codex', 'bad.md');
  await fs.writeFile(bad, '## User\nSynthetic rejected message\n', { mode: 0o600 });
  return { root, bad };
}

function assertPartial(result) {
  assert.equal(result.skippedFiles, 1);
  assert.deepEqual(result.sessions.map((s) => s.relativePath).sort(), [
    'claude-code/good.md', 'codex/good.md',
  ]);
  assert.deepEqual(Object.keys(result).sort(), ['sessions', 'skippedFiles']);
}

async function snapshot(root) {
  const entries = [];
  async function walk(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      const entry = { path: path.relative(root, file), mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs };
      if (stat.isFile()) entry.hash = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      entries.push(entry);
      if (stat.isDirectory()) await walk(file);
    }
  }
  await walk(root);
  return entries;
}

test('over-cap file is skipped while both agents remain readable, without library writes', async (t) => {
  const { root, bad } = await fixture(t);
  await fs.truncate(bad, MAX_SESSION_BYTES + 1);
  const before = await snapshot(root);
  assertPartial(await loadSessionLibrary(root));
  assert.deepEqual(await snapshot(root), before);
});

test('a transcript at the exact 50 MiB cap still loads', async (t) => {
  const { root, bad } = await fixture(t);
  await fs.truncate(bad, MAX_SESSION_BYTES);
  const result = await loadSessionLibrary(root);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.sessions.length, 3);
  assert.equal(result.sessions.find((s) => s.relativePath === 'codex/bad.md').body.length, MAX_SESSION_BYTES);
});

for (const code of ['EACCES', 'ENOENT']) {
  test(`a file stat rejected with ${code} does not discard other sessions`, async (t) => {
    const { root, bad } = await fixture(t);
    const lstat = fs.lstat;
    t.mock.method(fs, 'lstat', async (file, ...args) => {
      if (file === bad) throw Object.assign(new Error('sensitive rejected filename'), { code });
      return lstat(file, ...args);
    });
    assertPartial(await loadSessionLibrary(root));
  });
}

for (const scenario of ['permission', 'disappeared', 'symlink-swap', 'identity-swap']) {
  test(`safe-read ${scenario} rejection skips only the affected file`, async (t) => {
    const { root, bad } = await fixture(t);
    const { __testHooks } = await import('../../tools/session-import/lib/safe-read.mjs');
    t.after(() => { __testHooks.beforeOpen = null; __testHooks.betweenOpenAndStat = null; });
    const hook = scenario === 'identity-swap' ? 'betweenOpenAndStat' : 'beforeOpen';
    __testHooks[hook] = async (file) => {
      if (file !== bad) return;
      if (scenario === 'permission') throw Object.assign(new Error('EACCES sensitive filename'), { code: 'EACCES' });
      await fs.rename(bad, path.join(root, 'held-synthetic-file'));
      if (scenario === 'symlink-swap') await fs.symlink(path.join(root, 'held-synthetic-file'), bad);
      if (scenario === 'identity-swap') await fs.writeFile(bad, 'replacement must not load');
    };
    assertPartial(await loadSessionLibrary(root));
  });
}

test('all rejected files produce an empty successful load with a warning count', async (t) => {
  const { root } = await fixture(t);
  const { __testHooks } = await import('../../tools/session-import/lib/safe-read.mjs');
  t.after(() => { __testHooks.beforeOpen = null; });
  __testHooks.beforeOpen = async () => { throw Object.assign(new Error('cannot read'), { code: 'EACCES' }); };
  assert.deepEqual(await loadSessionLibrary(root), { sessions: [], skippedFiles: 3 });
});

test('invalid library roots and unavailable safe-read support still fail closed', async (t) => {
  const { root } = await fixture(t);
  const link = path.join(root, 'linked-root');
  await fs.symlink(root, link);
  await assert.rejects(loadSessionLibrary(link), /directory/);
  await assert.rejects(loadSessionLibrary(path.join(root, 'missing')), { code: 'ENOENT' });
  const { __testHooks } = await import('../../tools/session-import/lib/safe-read.mjs');
  const original = __testHooks.getONOFOLLOW;
  t.after(() => { __testHooks.getONOFOLLOW = original; });
  __testHooks.getONOFOLLOW = () => undefined;
  await assert.rejects(loadSessionLibrary(root), /symlink-safe reads unsupported/);
});

test('unexpected reader failures are not disguised as skipped transcripts', async (t) => {
  const { root } = await fixture(t);
  const { __testHooks } = await import('../../tools/session-import/lib/safe-read.mjs');
  t.after(() => { __testHooks.beforeOpen = null; });
  __testHooks.beforeOpen = async () => { throw new Error('unexpected implementation failure'); };
  await assert.rejects(loadSessionLibrary(root), /unexpected implementation failure/);
});

test('an unreadable directory still rejects the load rather than silently hiding a subtree', async (t) => {
  const { root } = await fixture(t);
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if (dir === path.join(root, 'codex')) throw Object.assign(new Error('directory denied'), { code: 'EACCES' });
    return readdir(dir, ...args);
  });
  await assert.rejects(loadSessionLibrary(root), { code: 'EACCES' });
});

test('a file moved outside the agent root after opening is rejected by the safe reader', async (t) => {
  const { root, bad } = await fixture(t);
  const { __testHooks } = await import('../../tools/session-import/lib/safe-read.mjs');
  t.after(() => { __testHooks.betweenOpenAndStat = null; });
  __testHooks.betweenOpenAndStat = async (file) => {
    if (file !== bad) return;
    const outside = path.join(root, 'outside-agent');
    await fs.rename(bad, outside);
    await fs.symlink(outside, bad);
  };
  assertPartial(await loadSessionLibrary(root));
});
