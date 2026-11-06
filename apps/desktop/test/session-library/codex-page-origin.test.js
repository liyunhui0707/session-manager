'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { zstdCompressSync } = require('node:zlib');
const { readOrigin, classifyHeader } = require('../../lib/codex-page-origin');
const id = '11111111-1111-4111-8111-111111111111';
const header = payload => ({ type: 'session_meta', payload: { id, ...payload } });

test('non-interactive exec and MCP records are not ordinary chats even when thread_source is user', () => {
  for (const source of ['exec', 'mcp']) {
    for (const thread_source of [undefined, 'user']) {
      assert.equal(classifyHeader(header({ source, thread_source }), id), 'automation');
    }
  }
  for (const source of ['cli', 'vscode', { custom: 'atlas' }, { custom: 'chatgpt' }]) {
    assert.equal(classifyHeader(header({ source }), id), 'user');
  }
  assert.equal(classifyHeader(header({ source: 'cli', title: 'Review task' }), id), 'user');
  assert.equal(classifyHeader(header({ thread_source: 'user' }), id), 'user');
  assert.equal(classifyHeader(header({ source: 'future-client' }), id), 'unknown');
});

test('structured subagent and internal origins identify background sessions independently of titles', () => {
  const parent = '22222222-2222-4222-8222-222222222222';
  for (const payload of [
    { source: { subagent: 'review' } }, { source: { subagent: 'compact' } },
    { source: { subagent: 'memory_consolidation' } },
    { source: { subagent: { other: 'worker' } } },
    { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } },
    { source: { internal: 'memory_consolidation' } },
    { thread_source: 'subagent' }, { thread_source: 'memory_consolidation' },
    { source: 'cli', parent_thread_id: parent },
  ]) assert.equal(classifyHeader(header(payload), id), 'background', JSON.stringify(payload));
});

test('unnamed main conversations, user forks and ambiguous origins are never hidden as subagents', () => {
  for (const payload of [{ source: 'cli' }, { thread_source: 'user' },
    { source: 'cli', forked_from_id: '22222222-2222-4222-8222-222222222222' }]) {
    assert.equal(classifyHeader(header(payload), id), 'user');
  }
  for (const payload of [{}, { parent_thread_id: id }, { parent_thread_id: 'invalid' },
    { source: { subagent: {} } }, { source: { subagent: { other: '' } } },
    { source: { subagent: { thread_spawn: {} } } }, { source: { subagent: 'future_kind' } },
    { source: { internal: 'future_kind' } }, { title: 'worker', text: 'recommended_plugins' }]) {
    assert.equal(classifyHeader(header(payload), id), 'unknown', JSON.stringify(payload));
  }
  assert.equal(classifyHeader(header({ id: 'different', thread_source: 'subagent' }), id), 'unknown');
});

test('only structured Guardian provenance identifies unnamed or renamed background reviews', () => {
  for (const payload of [{ source: { subagent: { other: 'guardian' } } },
    { source: { internal: 'guardian' } }, { thread_source: 'guardian_review' }]) {
    assert.equal(classifyHeader(header(payload), id), 'review');
  }
  for (const payload of [{ source: 'cli' }, { source: 'vscode' },
    { source: { subagent: 'review' } }, { source: { subagent: { other: 'guardian-like' } } },
    { source: 'cli', title: 'Guardian review', text: 'risk_level user_authorization' }, {}]) {
    assert.notEqual(classifyHeader(header(payload), id), 'review');
  }
  assert.equal(classifyHeader({ ...header({ source: { internal: 'guardian' } }), type: 'response_item' }, id), 'unknown');
  assert.equal(classifyHeader(header({ id: 'different', thread_source: 'guardian_review' }), id), 'unknown');
});

for (const compressed of [false, true]) test(`bounded first-header classification, not transcript content (${compressed ? 'zstd' : 'raw'})`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-origin-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'rollout-synthetic.jsonl' + (compressed ? '.zst' : ''));
  const source = { filePath, canonicalRoot: root, sessionId: id };
  const write = async text => fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text);
  // A huge invalid body must not be parsed or scanned to identify the header.
  await write(JSON.stringify(header({ source: { subagent: { other: 'guardian' } } })) + '\n' + 'x'.repeat(9 * 1024 ** 2));
  const before = await fs.readFile(filePath);
  assert.equal((await readOrigin(source)).origin, 'review');
  assert.deepEqual(await fs.readFile(filePath), before);
  await write(JSON.stringify(header({ source: 'cli' })) + '\n' + JSON.stringify(header({ thread_source: 'guardian_review' })) + '\n');
  assert.equal((await readOrigin(source)).origin, 'user');
  await write(JSON.stringify(header({ source: { internal: 'guardian' }, padding: 'x'.repeat(2 * 1024 ** 2) })) + '\n');
  assert.equal((await readOrigin(source)).origin, 'unknown');
  await write(JSON.stringify(header({ source: { internal: 'guardian' } }))); // Incomplete first line.
  assert.equal((await readOrigin(source)).origin, 'unknown');
  await write('{broken\n');
  assert.equal((await readOrigin(source)).origin, 'unknown');
  const link = path.join(root, 'rollout-link.jsonl'); await fs.symlink(filePath, link);
  assert.equal((await readOrigin({ ...source, filePath: link })).origin, 'unknown');
  assert.equal((await readOrigin({ ...source, filePath: filePath + '.missing' })).origin, 'unknown');
});

for (const compressed of [false, true]) test(`confirmed initialization-only sessions are hidden, uncertain and pending chats survive (${compressed})`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-empty-origin-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'rollout-empty.jsonl' + (compressed ? '.zst' : ''));
  const source = { filePath, canonicalRoot: root, sessionId: id };
  const initial = header({ source: 'cli', cwd: '/synthetic/worktree' });
  const write = async records => { const text = records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n'; await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text); };
  await write([initial, { type: 'turn_context', payload: {} }]);
  const empty = await readOrigin(source);
  assert.equal(empty.origin, 'empty'); assert.equal(empty.cwd, '/synthetic/worktree');
  assert.equal((await readOrigin(source, empty)).cached, true);
  await write([initial, { type: 'event_msg', payload: { type: 'user_message', message: 'Pending prompt' } }]);
  assert.equal((await readOrigin(source, empty)).origin, 'user');
  await write([initial, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] } }]);
  assert.equal((await readOrigin(source)).origin, 'user');
  await write([initial, { type: 'future_record', payload: {} }]);
  assert.equal((await readOrigin(source)).origin, 'user');
  await write([initial, '{broken']); assert.equal((await readOrigin(source)).origin, 'user');
  await write([initial, 'x'.repeat(2 * 1024 ** 2)]); assert.equal((await readOrigin(source)).origin, 'user');
});

for (const compressed of [false, true]) test(`editor settings-only initialization is empty, then becomes visible on prompt (${compressed})`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-editor-init-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'rollout-editor.jsonl' + (compressed ? '.zst' : ''));
  const source = { filePath, canonicalRoot: root, sessionId: id };
  const records = [header({ source: 'vscode' }), { type: 'event_msg', payload: { type: 'thread_settings_applied' } }];
  const write = async () => { const text = records.map(r => JSON.stringify(r)).join('\n') + '\n'; await fs.writeFile(filePath, compressed ? zstdCompressSync(text) : text); };
  await write(); const before = await fs.readFile(filePath), empty = await readOrigin(source);
  assert.equal(empty.origin, 'empty'); assert.deepEqual(await fs.readFile(filePath), before);
  records.push({ type: 'event_msg', payload: { type: 'user_message', message: 'A real pending prompt' } });
  await write(); assert.equal((await readOrigin(source, empty)).origin, 'user');
});
