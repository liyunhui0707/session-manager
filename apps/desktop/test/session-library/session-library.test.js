'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadSessionLibrary,
} = require('../../lib/session-library');

function makeTempLibrary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-session-library-'));
}

function writeSession(root, relativePath, frontmatter, body) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---', '', body);
  fs.writeFileSync(absolutePath, `${lines.join('\n')}\n`, { mode: 0o600 });
  return absolutePath;
}

function snapshotTree(root) {
  const entries = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const absolutePath = path.join(dir, name);
      const relativePath = path.relative(root, absolutePath);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        entries.push({ relativePath, kind: 'directory', mtimeMs: stat.mtimeMs });
        walk(absolutePath);
      } else if (stat.isSymbolicLink()) {
        entries.push({
          relativePath,
          kind: 'symlink',
          target: fs.readlinkSync(absolutePath),
          mtimeMs: stat.mtimeMs,
        });
      } else {
        entries.push({
          relativePath,
          kind: 'file',
          content: fs.readFileSync(absolutePath, 'utf8'),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  walk(root);
  return entries;
}

test('loads only Codex/Claude Markdown sessions without mutating the library', async (t) => {
  const root = makeTempLibrary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSession(root, 'claude-code/project/claude.md', {
    title: 'Claude fallback',
    agent: 'claude-code',
    source_session_id: 'claude-id',
    source_ai_title: 'Claude planning session',
    source_mtime: '2026-08-29T10:00:00.000Z',
  }, '## User\n\n你好 Claude');
  writeSession(root, 'codex/2026/08/30/codex.md', {
    title: 'Codex fallback',
    agent: 'codex',
    source_session_id: 'codex-id',
    source_custom_title: 'Thread renamed in Codex',
    source_mtime: '2026-08-30T11:00:00.000Z',
  }, '## User\n\nhello Codex 👋');
  writeSession(root, 'other/ignored.md', {
    agent: 'other',
  }, 'must not load');
  fs.writeFileSync(path.join(root, 'codex', 'ignore.txt'), 'not Markdown');
  fs.symlinkSync(
    path.join(root, 'claude-code', 'project', 'claude.md'),
    path.join(root, 'codex', 'linked.md'),
  );

  const before = snapshotTree(root);
  const { sessions, skippedFiles } = await loadSessionLibrary(root);
  const after = snapshotTree(root);

  assert.deepEqual(after, before, 'opening a library must not write or rewrite entries');
  assert.equal(skippedFiles, 0);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session) => session.relativePath).sort(),
    [
      'claude-code/project/claude.md',
      'codex/2026/08/30/codex.md',
    ],
  );

  const claude = sessions.find((session) => session.agent === 'claude');
  assert.equal(claude.title, 'Claude planning session');
  assert.match(claude.body, /你好 Claude/);
  assert.equal(claude.sessionsImport, true);

  const codex = sessions.find((session) => session.agent === 'codex');
  assert.equal(codex.title, 'Thread renamed in Codex');
  assert.match(codex.body, /hello Codex 👋/);
  assert.equal(codex.sourceMtime, Date.parse('2026-08-30T11:00:00.000Z'));
});

test('rejects missing, relative, and non-directory library paths', async (t) => {
  const root = makeTempLibrary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const regularFile = path.join(root, 'file');
  fs.writeFileSync(regularFile, 'x');

  await assert.rejects(() => loadSessionLibrary(''), /library/i);
  await assert.rejects(() => loadSessionLibrary('relative/path'), /absolute/i);
  await assert.rejects(() => loadSessionLibrary(regularFile), /directory/i);
});
