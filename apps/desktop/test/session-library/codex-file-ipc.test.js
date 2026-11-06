'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSourceState } = require('../../lib/session-source-state');
const { registerCodexFileIpc } = require('../../lib/codex-file-ipc');
const { registerLibraryIpc } = require('../../lib/session-library-ipc');
const Import = require('../../lib/session-import-ipc');
const direct = { name: 'rollout-synthetic.jsonl', sourceBytes: 1, conversation: { messages: [], diagnostics: {} } };
function harness() {
  const handlers = new Map();
  const trusted = {};
  const state = createSessionSourceState(event => event === trusted);
  const ipc = state.guard({ handle: (channel, fn) => handlers.set(channel, fn) });
  const calls = { reads: [], settings: 0, imports: 0, dialogs: 0 };
  const options = {
    sourceState: state,
    dialog: { showOpenDialog: async () => { calls.dialogs++; return { filePaths: ['/synthetic/rollout-one.jsonl'] }; } },
    loadFile: async file => { calls.reads.push(file); return options.readResult(); },
    readResult: async () => direct,
    importResult: async () => ({ imported: 0, skipped: 0, errors: 0 }),
    settings: { getLibraryPath: async () => { calls.settings++; return '/synthetic/library'; }, setLibraryPath: async () => {} },
    loadLibrary: async () => ({ sessions: [], skippedFiles: 0 }),
  };
  registerCodexFileIpc(ipc, options);
  registerLibraryIpc(ipc, options);
  Import.register(ipc, { canImport: () => state.canImport(), getLibraryPath: () => options.settings.getLibraryPath(), importers: {
    runClaudeImport: async () => { calls.imports++; return options.importResult(); }, runCodexImport: async () => { calls.imports++; return options.importResult(); },
  } });
  return { state, calls, options, invoke: (channel, ...args) => handlers.get(channel)(trusted, ...args), untrusted: channel => handlers.get(channel)({}) };
}
test('all source IPC rejects foreign senders and extra arguments before touching paths', async () => {
  const h = harness();
  for (const channel of ['codexFile:choose', 'codexFile:reload', 'sessionLibrary:choose', 'sessionLibrary:load', 'sessionLibrary:get-selected', 'sessionViewer:import']) {
    assert.equal((await h.untrusted(channel)).reason, 'invalid-request');
    assert.equal((await h.invoke(channel, '/injected/path')).reason, 'invalid-request');
  }
  assert.deepEqual(h.calls, { reads: [], settings: 0, imports: 0, dialogs: 0 });
});
test('native choice, Reload and Refresh exclusion share main-owned source state', async () => {
  const h = harness();
  assert.equal((await h.invoke('codexFile:reload')).reason, 'no-source');
  assert.deepEqual(await h.invoke('codexFile:choose'), { ok: true, session: direct });
  assert.equal(h.calls.settings, 0);
  assert.deepEqual(await h.invoke('codexFile:reload'), { ok: true, session: direct });
  assert.deepEqual(h.calls.reads, ['/synthetic/rollout-one.jsonl', '/synthetic/rollout-one.jsonl']);
  assert.equal((await h.invoke('sessionViewer:import')).reason, 'read-only-source');
  assert.equal(h.calls.settings, 0);
  assert.equal(h.calls.imports, 0);
  await h.invoke('sessionLibrary:load');
  assert.equal(h.state.canImport(), true);
  assert.equal((await h.invoke('codexFile:reload')).reason, 'no-source');
});
test('cancelled/failed choices and failed Reload retain source without exposing error details', async () => {
  const h = harness();
  await h.invoke('codexFile:choose');
  h.options.dialog.showOpenDialog = async () => ({ canceled: true });
  assert.equal((await h.invoke('codexFile:choose')).reason, 'cancelled');
  h.options.dialog.showOpenDialog = async () => { throw new Error('/private/path secret'); };
  const failed = await h.invoke('codexFile:choose');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal(h.state.getCodexPath(), '/synthetic/rollout-one.jsonl');
  h.options.settings.getLibraryPath = async () => { throw new Error('private'); };
  assert.equal((await h.invoke('sessionLibrary:load')).ok, false);
  assert.equal(h.state.canImport(), false);
  assert.equal((await h.invoke('codexFile:reload')).ok, true);
  h.options.settings.getLibraryPath = async () => null;
  assert.equal((await h.invoke('sessionLibrary:load')).reason, 'no-library');
  assert.equal(h.state.canImport(), true);
});
test('one guard serializes source changes and releases after failure', async () => {
  const h = harness();
  let finish;
  h.options.dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
  const pending = h.invoke('codexFile:choose');
  for (const channel of ['codexFile:reload', 'sessionLibrary:choose', 'sessionLibrary:load', 'sessionViewer:import']) {
    assert.equal((await h.invoke(channel)).reason, 'in-progress');
  }
  finish({ canceled: true });
  await pending;
  assert.equal((await h.invoke('sessionLibrary:load')).ok, true);
});

test('failed Reload keeps selected source and sanitizes unsafe-read errors', async () => {
  const h = harness();
  await h.invoke('codexFile:choose');
  for (const [error, reason] of [[Object.assign(new Error('/private/file'), { code: 'OVER_CAP' }), 'over-cap'], [new Error('symlink-safe reads unsupported on this platform: private'), 'platform-unsupported'], [new Error('private'), 'invalid-file']]) {
    h.options.readResult = async () => { throw error; };
    assert.deepEqual(await h.invoke('codexFile:reload'), { ok: false, reason });
    assert.equal(h.state.canImport(), false);
  }
  h.options.readResult = async () => direct;
  assert.equal((await h.invoke('codexFile:reload')).ok, true);
});
test('source selection remains locked until both synthetic importers settle', async () => {
  const h = harness();
  let rejectFirst, finishSecond;
  let count = 0;
  h.options.importResult = () => ++count === 1
    ? new Promise((_, reject) => { rejectFirst = reject; })
    : new Promise(resolve => { finishSecond = resolve; });
  const refresh = h.invoke('sessionViewer:import');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.imports, 2);
  rejectFirst(new Error('synthetic failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.invoke('codexFile:choose')).reason, 'in-progress');
  assert.equal((await h.invoke('sessionLibrary:choose')).reason, 'in-progress');
  finishSecond({ imported: 0, skipped: 0, errors: 0 });
  assert.equal((await refresh).ok, false);
  assert.equal((await h.invoke('codexFile:choose')).ok, true);
});
