'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSourceState } = require('../../lib/session-source-state');
const { registerCodexPageIpc } = require('../../lib/codex-page-ipc');
const id = '11111111-1111-4111-8111-111111111111';
test('page IPC rejects renderer paths, untrusted callers and old source bindings', async () => {
  const handlers = new Map(); let calls = 0;
  const state = createSessionSourceState(e => e.trusted);
  const reader = { getSource: () => ({ filePath: '/synthetic/rollout-a.jsonl', mode: 'codex' }),
    move: async () => { calls++; return { page: { readerId: id } }; }, cancel: async () => true };
  registerCodexPageIpc(state.guard({ handle: (key, fn) => handlers.set(key, fn) }), { reader, sourceState: state });
  const move = handlers.get('codexPage:move');
  state.useCodex('/synthetic/rollout-a.jsonl');
  assert.equal((await move({}, id, 'next')).reason, 'invalid-request');
  assert.equal((await move({ trusted: true }, '/private/path', 'next')).reason, 'invalid-request');
  assert.equal((await move({ trusted: true }, id, 128)).reason, 'invalid-request');
  assert.equal((await move({ trusted: true }, id, 'next')).ok, true);
  state.useLibrary();
  assert.equal((await move({ trusted: true }, id, 'next')).reason, 'stale-reader');
  assert.equal(calls, 1);
});
test('folder generation changes revoke old page navigation; failures stay path-free', async () => {
  const handlers = new Map();
  const entry = { entryId: id, sessionId: 'synthetic', filePath: '/synthetic/rollout-a.jsonl' };
  const state = createSessionSourceState(() => true);
  const catalog = { canonicalRoot: '/synthetic', entries: [entry], diagnostics: {} };
  state.commitFolderScan(state.beginFolderScan('/synthetic'), catalog);
  state.selectFolderEntry(id);
  const reader = { getSource: () => ({ ...entry, mode: 'folder', generation: 1 }),
    move: async () => { throw Object.assign(new Error('/private/secret'), { code: 'SOURCE_CHANGED' }); } };
  registerCodexPageIpc(state.guard({ handle: (k, f) => handlers.set(k, f) }), { reader, sourceState: state });
  const move = handlers.get('codexPage:move');
  assert.deepEqual(await move({}, id, 'next'), { ok: false, reason: 'source-changed' });
  state.commitFolderScan(state.beginFolderScan('/synthetic'), catalog, { preserveSelection: true });
  assert.equal((await move({}, id, 'next')).reason, 'stale-reader');
});

test('decompression failures and resource limits have distinct path-free IPC reasons', () => {
  const { pageFailure } = require('../../lib/codex-page-ipc');
  for (const [code, reason] of [['DECOMPRESSION_FAILED', 'decompression-failed'], ['DECOMPRESSION_LIMIT', 'decompression-limit']]) {
    assert.deepEqual(pageFailure({ code, message: '/private/source' }), { ok: false, reason });
  }
});
