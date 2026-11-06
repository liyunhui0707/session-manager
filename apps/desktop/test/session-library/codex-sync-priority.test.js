'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSourceState } = require('../../lib/session-source-state');
const { registerConversationServices } = require('../../lib/codex-page-services');
function harness() {
  let trusted = true, releaseScan, signal, foregroundCalls = 0;
  const state = createSessionSourceState(() => trusted), handlers = new Map();
  const catalog = { canonicalRoot: '/synthetic', sourceId: 'old', entries: [], diagnostics: {} };
  state.commitFolderScan(state.beginFolderScan('/synthetic'), catalog);
  const ipc = state.guard({ handle: (key, handler) => handlers.set(key, handler) });
  registerConversationServices(ipc, { sourceState: state, reader: {},
    scanSource: async (_root, options) => {
      signal = options.signal;
      await new Promise(resolve => { releaseScan = resolve; });
      return { ...catalog, sourceId: 'late-old' };
    },
    searchReader: {},
  });
  ipc.handle('synthetic:choose', () => { foregroundCalls++; state.useLibrary(); return { ok: true }; });
  ipc.handle('synthetic:cancel', () => ({ ok: true }), { allowWhileBusy: true });
  return { state, call: name => handlers.get(name)({}), release: () => releaseScan(),
    untrust: () => { trusted = false; }, get signal() { return signal; }, get calls() { return foregroundCalls; } };
}
test('foreground source action interrupts a background scan and waits for its release', async () => {
  const h = harness(), sync = h.call('codexConversation:sync');
  const choose = h.call('synthetic:choose');
  assert.equal(h.signal.aborted, true);
  assert.equal(h.calls, 0, 'source must not change until scanner releases');
  assert.equal((await h.call('synthetic:choose')).reason, 'in-progress', 'only one foreground waiter');
  assert.equal((await h.call('codexConversation:sync')).reason, 'in-progress');
  assert.equal((await h.call('synthetic:cancel')).ok, true, 'cancel remains available');
  h.release();
  assert.equal((await sync).reason, 'cancelled');
  assert.equal((await choose).ok, true);
  assert.equal(h.calls, 1); assert.equal(h.state.getMode(), 'library');
  assert.equal(h.state.getFolderCatalog(), null, 'cancelled sync cannot publish old catalog');
});
test('queued work rechecks sender trust after the background task releases', async () => {
  const h = harness(), sync = h.call('codexConversation:sync');
  const choose = h.call('synthetic:choose');
  h.untrust(); h.release(); await sync;
  assert.equal((await choose).reason, 'invalid-request');
  assert.equal(h.calls, 0);
});

test('an untrusted foreground request cannot interrupt a background scan', async () => {
  const h = harness(), sync = h.call('codexConversation:sync');
  h.untrust();
  assert.equal((await h.call('synthetic:choose')).reason, 'invalid-request');
  assert.equal(h.signal.aborted, false); assert.equal(h.calls, 0);
  h.release(); await sync;
});

test('a background failure releases the queued action without unlocking other foreground work', async () => {
  const handlers = new Map(), state = createSessionSourceState(() => true);
  const ipc = state.guard({ handle: (name, fn) => handlers.set(name, fn) });
  let reject, releaseForeground, interrupted = false;
  ipc.handle('poll', () => new Promise((_, fail) => { reject = fail; }),
    { background: true, interrupt: () => { interrupted = true; reject(Error('synthetic')); } });
  ipc.handle('read', () => new Promise(resolve => { releaseForeground = resolve; }));
  const poll = handlers.get('poll')({}), read = handlers.get('read')({});
  assert.equal(interrupted, true);
  assert.equal((await poll).reason, 'operation-failed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await handlers.get('read')({})).reason, 'in-progress');
  releaseForeground({ ok: true }); assert.equal((await read).ok, true);
});

test('scanner abort rejection is normal cancellation rather than an update failure', async () => {
  const handlers = new Map(), state = createSessionSourceState(() => true);
  state.commitFolderScan(state.beginFolderScan('/synthetic'), { canonicalRoot: '/synthetic', sourceId: 'old', entries: [], diagnostics: {} });
  const ipc = state.guard({ handle: (name, fn) => handlers.set(name, fn) });
  registerConversationServices(ipc, { sourceState: state, reader: {}, searchReader: {},
    scanSource: (_root, { signal }) => new Promise((_, reject) => signal.addEventListener('abort',
      () => reject(Object.assign(Error('synthetic abort'), { code: 'SCAN_CANCELLED' })), { once: true })) });
  ipc.handle('choose', () => ({ ok: true }));
  const poll = handlers.get('codexConversation:sync')({});
  const choose = handlers.get('choose')({});
  assert.equal((await poll).reason, 'cancelled');
  assert.equal((await choose).ok, true);
});
