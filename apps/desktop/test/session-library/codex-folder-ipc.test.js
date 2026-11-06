'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSourceState } = require('../../lib/session-source-state');
const { registerCodexFolderIpc } = require('../../lib/codex-folder-ipc');
const Import = require('../../lib/session-import-ipc');

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function catalog(root, sourceId = 'source-a', entryId = ENTRY_ID) {
  const entries = [{
    entryId,
    sessionId: SESSION_ID,
    title: 'Synthetic session',
    updatedAt: 10,
    bytes: 20,
    area: 'active',
    filePath: `${root}/sessions/2026/09/01/rollout-synthetic.jsonl`,
    fileName: 'rollout-synthetic.jsonl',
    canonicalRoot: root,
  }];
  return {
    layout: 'full', sourceId, canonicalRoot: root, generation: 0, entries,
    diagnostics: { skipped: 0, errors: 0, duplicates: 0, indexErrors: 0 },
  };
}

function harness() {
  const handlers = new Map();
  const trusted = {};
  const sourceState = createSessionSourceState((event) => event === trusted);
  const ipc = sourceState.guard({ handle: (channel, handler) => handlers.set(channel, handler) });
  const calls = { scans: [], loads: [], dialogs: 0 };
  const options = {
    sourceState,
    dialog: {
      async showOpenDialog() {
        calls.dialogs += 1;
        return { canceled: false, filePaths: ['/synthetic/a'] };
      },
    },
    async scanSource(root, scanOptions) {
      calls.scans.push({ root, signal: scanOptions.signal });
      return catalog(root);
    },
    async loadEntry(entry) {
      calls.loads.push(entry);
      return { name: entry.title, sourceBytes: entry.bytes, conversation: { messages: [], diagnostics: {} } };
    },
  };
  registerCodexFolderIpc(ipc, options);
  return {
    options, sourceState, calls,
    invoke(channel, ...args) { return handlers.get(channel)(trusted, ...args); },
    untrusted(channel, ...args) { return handlers.get(channel)({}, ...args); },
  };
}

test('native folder selection returns sanitized catalog and loads bodies only by current opaque ID', async () => {
  const h = harness();
  const selected = await h.invoke('codexFolder:choose');
  assert.equal(selected.ok, true);
  assert.equal(selected.catalog.entries[0].entryId, ENTRY_ID);
  assert.equal(JSON.stringify(selected).includes('/synthetic'), false);
  assert.equal(h.sourceState.canImport(), false);

  assert.equal((await h.invoke('codexFolder:load', '/synthetic/a/file')).reason, 'invalid-request');
  assert.equal((await h.invoke('codexFolder:load', '00000000-0000-4000-8000-000000000000')).reason, 'unknown-entry');
  const loaded = await h.invoke('codexFolder:load', ENTRY_ID);
  assert.equal(loaded.ok, true);
  assert.equal(h.calls.loads.length, 1);
  assert.equal(h.calls.loads[0].filePath.includes('/synthetic/a'), true);
  assert.equal(JSON.stringify(loaded).includes('/synthetic'), false);
  assert.equal((await h.invoke('codexFolder:reload')).ok, true);
});

test('cancelled/failed scans preserve the previous catalog and old IDs become stale only after success', async () => {
  const h = harness();
  await h.invoke('codexFolder:choose');
  h.options.dialog.showOpenDialog = async () => ({ canceled: true });
  assert.equal((await h.invoke('codexFolder:choose')).reason, 'cancelled');
  assert.equal((await h.invoke('codexFolder:load', ENTRY_ID)).ok, true);

  h.options.dialog.showOpenDialog = async () => ({ filePaths: ['/synthetic/b'] });
  h.options.scanSource = async () => { throw new Error('/private/path'); };
  const failed = await h.invoke('codexFolder:choose');
  assert.equal(failed.reason, 'invalid-source');
  assert.equal(JSON.stringify(failed).includes('private'), false);
  assert.equal((await h.invoke('codexFolder:load', ENTRY_ID)).ok, true);

  const replacementId = '22222222-2222-4222-8222-222222222222';
  h.options.scanSource = async (root) => catalog(root, 'source-b', replacementId);
  assert.equal((await h.invoke('codexFolder:choose')).ok, true);
  assert.equal((await h.invoke('codexFolder:load', ENTRY_ID)).reason, 'unknown-entry');
  assert.equal((await h.invoke('codexFolder:load', replacementId)).ok, true);
});

test('read-only Rescan replaces metadata, preserves logical selection, and never invokes a picker', async () => {
  const h = harness();
  await h.invoke('codexFolder:choose');
  await h.invoke('codexFolder:load', ENTRY_ID);
  const replacementId = '33333333-3333-4333-8333-333333333333';
  h.options.scanSource = async (root) => catalog(root, 'source-a', replacementId);

  const result = await h.invoke('codexFolder:rescan');
  assert.equal(result.ok, true);
  assert.equal(result.catalog.selectedEntryId, replacementId);
  assert.equal(h.calls.dialogs, 1);
  assert.equal((await h.invoke('codexFolder:reload')).ok, true);
  assert.equal(h.calls.loads.at(-1).entryId, replacementId);
});

test('incomplete native Rescan failure preserves the last complete catalog', async () => {
  const h = harness();
  await h.invoke('codexFolder:choose');
  h.options.scanSource = async () => {
    throw Object.assign(new Error('incomplete helper response'), { code: 'SCAN_PROTOCOL_ERROR' });
  };

  assert.equal((await h.invoke('codexFolder:rescan')).reason, 'invalid-source');
  assert.equal((await h.invoke('codexFolder:load', ENTRY_ID)).ok, true);
  assert.equal(h.sourceState.getFolderCatalog().entries[0].entryId, ENTRY_ID);
});

test('unsupported native scanning is reported without exposing implementation details', async () => {
  const h = harness();
  h.options.scanSource = async () => {
    throw Object.assign(new Error('/private/helper missing'), { code: 'PLATFORM_UNSUPPORTED' });
  };

  const result = await h.invoke('codexFolder:choose');
  assert.deepEqual(result, { ok: false, reason: 'platform-unsupported' });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('switching roots clears selection even when the new source reuses a logical session ID', async () => {
  const h = harness();
  await h.invoke('codexFolder:choose');
  await h.invoke('codexFolder:load', ENTRY_ID);
  const replacementId = '44444444-4444-4444-8444-444444444444';
  h.options.dialog.showOpenDialog = async () => ({ filePaths: ['/synthetic/b'] });
  h.options.scanSource = async (root) => catalog(root, 'source-b', replacementId);

  const result = await h.invoke('codexFolder:choose');

  assert.equal(result.ok, true);
  assert.equal(result.catalog.selectedEntryId, null);
  assert.equal((await h.invoke('codexFolder:reload')).reason, 'no-source');
});

test('trusted cancellation can abort an in-progress scan without weakening other guarded IPC', async () => {
  const h = harness();
  h.options.scanSource = (_root, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'SCAN_CANCELLED' })));
  });
  const pending = h.invoke('codexFolder:choose');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.untrusted('codexFolder:cancel')).reason, 'invalid-request');
  assert.equal((await h.invoke('codexFolder:load', ENTRY_ID)).reason, 'in-progress');
  assert.deepEqual(await h.invoke('codexFolder:cancel'), { ok: true });
  assert.equal((await pending).reason, 'cancelled');
  assert.equal(h.sourceState.canImport(), true);
});

test('Refresh is rejected in folder mode before settings or importers are touched', async () => {
  const h = harness();
  let settings = 0;
  let imports = 0;
  const handlers = new Map();
  const trusted = {};
  const sourceState = createSessionSourceState((event) => event === trusted);
  const ipc = sourceState.guard({ handle: (channel, handler) => handlers.set(channel, handler) });
  registerCodexFolderIpc(ipc, {
    sourceState,
    dialog: { showOpenDialog: async () => ({ filePaths: ['/synthetic/a'] }) },
    scanSource: async (root) => catalog(root),
  });
  Import.register(ipc, {
    canImport: () => sourceState.canImport(),
    getLibraryPath: async () => { settings += 1; return '/synthetic/library'; },
    importers: {
      runClaudeImport: async () => { imports += 1; },
      runCodexImport: async () => { imports += 1; },
    },
  });
  await handlers.get('codexFolder:choose')(trusted);
  assert.deepEqual(await handlers.get('sessionViewer:import')(trusted), { ok: false, reason: 'read-only-source' });
  assert.equal(settings, 0);
  assert.equal(imports, 0);
  assert.equal(h.calls.imports, undefined);
});

test('startup restores the selected Codex root without a dialog and falls back to default', async () => {
  const h = harness();
  h.options.defaultRoot = '/synthetic/default';
  h.options.settings = { getSource: async () => ({ kind: 'codex', path: '/synthetic/saved' }), setCodexPath: async () => {} };
  assert.equal((await h.invoke('codexFolder:restore')).ok, true);
  assert.equal(h.calls.scans.at(-1).root, '/synthetic/saved'); assert.equal(h.calls.dialogs, 0);
  h.options.scanSource = async root => { h.calls.scans.push({ root }); if (root.endsWith('saved')) throw Error('missing'); return catalog(root); };
  assert.equal((await h.invoke('codexFolder:restore')).ok, true);
  assert.equal(h.calls.scans.at(-1).root, '/synthetic/default');
  h.options.settings.getSource = async () => ({ kind: 'library' });
  assert.equal((await h.invoke('codexFolder:restore')).reason, 'library-selected');
  assert.equal((await h.untrusted('codexFolder:restore')).reason, 'invalid-request');
  assert.equal((await h.invoke('codexFolder:restore', '/injected')).reason, 'invalid-request');
});
