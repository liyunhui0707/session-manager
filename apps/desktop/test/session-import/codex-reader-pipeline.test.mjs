import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runCodexImport } from '../../tools/session-import/import-codex.mjs';
import { FIXED_NOW, mkTempVault, cleanupTempVault } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { loadSessionLibrary } = require('../../lib/session-library');
const { renderMarkdown } = require('../../lib/session-viewer/read-renderer');
const { extractReadTextRuns } = require('../../lib/session-viewer/read-search-text');
const { searchIndex } = require('../../lib/session-viewer/search-index');
const { makeFakeDocument, flattenText } = require('../session-viewer/read-fake-document');

// Generated synthetic records only; never discover the user's Codex home.
function message(role, text) {
  return {
    type: 'response_item',
    payload: {
      type: 'message', role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  };
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

async function fixture(t, records) {
  const root = await fs.realpath(mkTempVault('asm-codex-pipeline-'));
  t.after(() => cleanupTempVault(root));
  const sourceRoot = path.join(root, 'synthetic-codex/sessions');
  const day = path.join(sourceRoot, '2026/01/01');
  await fs.mkdir(day, { recursive: true });
  const sourceFile = path.join(day,
    'rollout-2026-01-01T00-00-00-019c5f21-83e1-72c2-a129-83fa090f4c41.jsonl');
  await fs.writeFile(sourceFile, jsonl(records), { mode: 0o600 });
  const library = path.join(root, 'library');
  const outputBase = path.join(library, 'codex');
  const refresh = () => runCodexImport({ sourceRoot, outputBase,
    maxBytes: 52428800, now: FIXED_NOW });
  return { sourceRoot, sourceFile, library, refresh };
}

async function snapshot(root) {
  const entries = {};
  async function visit(file) {
    const stat = await fs.lstat(file);
    entries[path.relative(root, file)] = {
      mode: stat.mode, mtime: stat.mtimeMs,
      ...(stat.isFile() ? { bytes: (await fs.readFile(file)).toString('base64') } : {}),
    };
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    }
  }
  await visit(root);
  return entries;
}

async function readConversation(library) {
  const before = await snapshot(library);
  const loaded = await loadSessionLibrary(library);
  assert.equal(loaded.skippedFiles, 0);
  const views = loaded.sessions.map((session) => {
    const document = makeFakeDocument();
    const rendered = renderMarkdown(session.body, { document });
    assert.equal(document.unsafeApiWrites, 0);
    const turns = rendered.children.map((section) => ({
      role: section.attrs.class.includes('user-turn') ? 'user' : 'assistant',
      text: section.children.slice(1).map(flattenText).join('\n'),
    }));
    return { session, rendered, turns,
      index: [{ id: session.id, textContent: extractReadTextRuns(session.body) }] };
  });
  assert.deepEqual(await snapshot(library), before, 'loading/rendering/indexing is read-only');
  return views;
}

test('Codex pipeline: preserves ordered multilingual turns and intentional repeated text', async (t) => {
  const expected = [
    { role: 'user', text: '你好，explain café 🚀' },
    { role: 'assistant', text: 'First answer 第一条' },
    { role: 'user', text: '你好，explain café 🚀' },
    { role: 'assistant', text: 'Second answer 第二条' },
  ];
  const f = await fixture(t, expected.map(({ role, text }) => message(role, text)));
  const before = await snapshot(f.sourceRoot);
  assert.equal((await f.refresh()).errors, 0);
  const [view] = await readConversation(f.library);
  assert.deepEqual(view.turns, expected);
  assert.equal(searchIndex(view.index, '你好')[0].matchCount, 2);
  assert.equal(searchIndex(view.index, 'Second answer')[0].matchCount, 1);
  assert.deepEqual(await snapshot(f.sourceRoot), before, 'import is read-only on source');
});

test('Codex pipeline: event mirrors do not duplicate canonical message records', async (t) => {
  const f = await fixture(t, [
    message('user', 'Question marker'),
    { type: 'event_msg', payload: { type: 'user_message', message: 'Question marker' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Answer marker' } },
    message('assistant', 'Answer marker'),
  ]);
  await f.refresh();
  const [view] = await readConversation(f.library);
  assert.deepEqual(view.turns, [
    { role: 'user', text: 'Question marker' },
    { role: 'assistant', text: 'Answer marker' },
  ]);
  assert.equal(searchIndex(view.index, 'Answer marker')[0].matchCount, 1);
});

test('Codex pipeline: incomplete final record becomes visible after explicit re-import', async (t) => {
  const f = await fixture(t, [message('user', 'Pending question')]);
  const answer = JSON.stringify(message('assistant', 'Completed answer'));
  const split = Math.floor(answer.length / 2);
  await fs.appendFile(f.sourceFile, answer.slice(0, split));
  const before = await snapshot(f.sourceRoot);
  await f.refresh();
  const [initial] = await readConversation(f.library);
  assert.deepEqual(initial.turns, [{ role: 'user', text: 'Pending question' }]);
  assert.deepEqual(await snapshot(f.sourceRoot), before);

  // Only this test writer completes the source record, simulating the CLI.
  await fs.appendFile(f.sourceFile, answer.slice(split) + '\n');
  const completed = await snapshot(f.sourceRoot);
  await f.refresh();
  const refreshed = await readConversation(f.library);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].session.id, initial.session.id);
  assert.deepEqual(refreshed[0].turns, [
    { role: 'user', text: 'Pending question' },
    { role: 'assistant', text: 'Completed answer' },
  ]);
  await f.refresh();
  assert.deepEqual((await readConversation(f.library))[0].turns, refreshed[0].turns);
  assert.deepEqual(await snapshot(f.sourceRoot), completed);
});

test('Codex pipeline: malformed records preserve healthy messages in the same and another file', async (t) => {
  const f = await fixture(t, [message('user', 'Before corruption')]);
  await fs.appendFile(f.sourceFile, '{broken json}\n' + jsonl([
    message('assistant', 'After corruption'),
  ]));
  const other = f.sourceFile.replace('090f4c41', '090f4c42');
  await fs.writeFile(other, jsonl([message('user', 'Healthy other session')]));
  const before = await snapshot(f.sourceRoot);
  const result = await f.refresh();
  assert.equal(result.imported, 2);
  const views = await readConversation(f.library);
  assert.equal(views.length, 2);
  assert.deepEqual(views.flatMap((view) => view.turns).map((turn) => turn.text).sort(),
    ['After corruption', 'Before corruption', 'Healthy other session']);
  assert.deepEqual(await snapshot(f.sourceRoot), before);
});

test('Codex pipeline: fenced role text stays in its turn and hostile markup creates no active elements', async (t) => {
  const code = '## Assistant\n<script>alert(1)</script>\n<img src="https://example.invalid/pixel">';
  const f = await fixture(t, [
    message('user', '```text\n' + code + '\n```'),
    message('assistant', '<script>unsafe()</script> ![remote](https://example.invalid/image)'),
  ]);
  await f.refresh();
  const [view] = await readConversation(f.library);
  assert.equal(view.turns.length, 2);
  assert.deepEqual(view.turns[0], { role: 'user', text: code });
  const tags = [];
  function collect(node) {
    if (node.tag) tags.push(node.tag);
    for (const child of node.children || []) collect(child);
  }
  collect(view.rendered);
  assert.ok(!tags.some((tag) => ['script', 'img', 'iframe', 'a'].includes(tag)));
  assert.equal(searchIndex(view.index, 'alert(1)')[0].matchCount, 1);
});
