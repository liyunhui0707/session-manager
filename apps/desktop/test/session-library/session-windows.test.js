'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWindowRouter, createWindowSettings } = require('../../lib/session-windows');
const { createSessionSourceState } = require('../../lib/session-source-state');

test('routes only registered senders and isolates busy jobs and cancellation', async () => {
  const channels = new Map();
  const router = createWindowRouter({ handle: (name, fn) => channels.set(name, fn) });
  const a = {}, b = {}, outsider = {};
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  for (const sender of [a, b]) {
    const state = createSessionSourceState(event => event.senderFrame === sender);
    const ipc = state.guard(router.attach(sender));
    ipc.handle('read', async () => { if (sender === a) await pending; return { ok: true, window: sender }; });
    ipc.handle('cancel', () => ({ ok: true, window: sender }), { allowWhileBusy: true });
  }
  const invoke = (name, sender, senderFrame = sender) => channels.get(name)({ sender, senderFrame });
  const reading = invoke('read', a);
  assert.equal((await invoke('read', a)).reason, 'in-progress');
  assert.equal((await invoke('read', b)).window, b);
  assert.equal((await invoke('cancel', b)).window, b);
  assert.equal((await invoke('read', outsider)).ok, false);
  assert.equal((await invoke('read', b, outsider)).ok, false);
  router.detach(a);
  assert.equal((await invoke('cancel', a)).ok, false);
  finish(); await reading;
  assert.equal((await invoke('read', b)).ok, true);
  assert.equal(channels.size, 2, 'each channel registered once across windows');
});

test('each window keeps its source while persisting choices for future launches', async () => {
  let source = { kind: 'library', path: '/synthetic/codex' }, libraryPath = '/synthetic/one';
  const shared = { getSource: async () => source, getLibraryPath: async () => libraryPath,
    setLibraryPath: async value => { libraryPath = value; source = { ...source, kind: 'library' }; },
    setCodexPath: async value => { source = { kind: 'codex', path: value }; } };
  const a = createWindowSettings(shared), b = createWindowSettings(shared);
  await Promise.all([a.getSource(), b.getSource()]);
  await a.setLibraryPath('/synthetic/two');
  assert.equal(await b.getLibraryPath(), '/synthetic/one');
  await b.setCodexPath('/synthetic/other');
  assert.equal((await a.getSource()).kind, 'library');
  const child = createWindowSettings(shared, await a.snapshot());
  assert.equal(await child.getLibraryPath(), '/synthetic/two');
  assert.equal((await child.getSource()).kind, 'library');
  assert.deepEqual(await shared.getSource(), { kind: 'codex', path: '/synthetic/other' });
});
