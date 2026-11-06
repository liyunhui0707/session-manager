'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHANNELS,
  registerLibraryIpc,
} = require('../../lib/session-library-ipc');

function makeIpc() {
  const handlers = {};
  return {
    handlers,
    handle(channel, handler) {
      handlers[channel] = handler;
    },
    invoke(channel, payload) {
      return handlers[channel]({}, payload);
    },
  };
}

test('main process owns get, choose, and load library operations', async () => {
  const ipc = makeIpc();
  const calls = { set: [], load: [] };
  let selected = null;
  const settings = {
    async getLibraryPath() { return selected; },
    async setLibraryPath(value) {
      calls.set.push(value);
      selected = value;
    },
  };
  const dialog = {
    async showOpenDialog() {
      return { canceled: false, filePaths: ['/chosen/library'] };
    },
  };
  const loadLibrary = async (libraryPath) => {
    calls.load.push(libraryPath);
    return { sessions: [{ id: 'codex/a.md' }], skippedFiles: 2, errors: ['sensitive rejected filename'] };
  };

  registerLibraryIpc(ipc, { dialog, settings, loadLibrary });

  assert.deepEqual(
    await ipc.invoke(CHANNELS.GET_SELECTED, { libraryPath: '/ignored' }),
    { ok: true, libraryPath: null },
  );
  assert.deepEqual(
    await ipc.invoke(CHANNELS.CHOOSE, { libraryPath: '/ignored' }),
    {
      ok: true,
      libraryPath: '/chosen/library',
      sessions: [{ id: 'codex/a.md' }],
      skippedFiles: 2,
    },
  );
  assert.deepEqual(calls.load, ['/chosen/library']);
  assert.deepEqual(calls.set, ['/chosen/library']);
  assert.deepEqual(
    await ipc.invoke(CHANNELS.LOAD, { libraryPath: '/renderer/cannot/read' }),
    {
      ok: true,
      libraryPath: '/chosen/library',
      sessions: [{ id: 'codex/a.md' }],
      skippedFiles: 2,
    },
  );
  assert.deepEqual(calls.load, ['/chosen/library', '/chosen/library']);
});

test('cancel, no selection, and load errors return typed sanitized results', async () => {
  const cancelIpc = makeIpc();
  registerLibraryIpc(cancelIpc, {
    dialog: {
      async showOpenDialog() {
        return { canceled: true, filePaths: [] };
      },
    },
    settings: {
      async getLibraryPath() { return null; },
      async setLibraryPath() { throw new Error('must not persist'); },
    },
    async loadLibrary() { throw new Error('must not load'); },
  });

  assert.deepEqual(
    await cancelIpc.invoke(CHANNELS.CHOOSE),
    { ok: false, reason: 'cancelled' },
  );
  assert.deepEqual(
    await cancelIpc.invoke(CHANNELS.LOAD),
    { ok: false, reason: 'no-library' },
  );

  const failingIpc = makeIpc();
  registerLibraryIpc(failingIpc, {
    dialog: {
      async showOpenDialog() {
        return { canceled: false, filePaths: ['/private/user/library'] };
      },
    },
    settings: {
      async getLibraryPath() { return '/private/user/library'; },
      async setLibraryPath() { throw new Error('must not persist invalid path'); },
    },
    async loadLibrary() {
      throw new Error('ENOENT /private/user/library/secret.md');
    },
  });

  for (const channel of [CHANNELS.CHOOSE, CHANNELS.LOAD]) {
    const result = await failingIpc.invoke(channel);
    assert.deepEqual(result, { ok: false, reason: 'invalid-library' });
    assert.equal(JSON.stringify(result).includes('/private/user'), false);
  }
});

test('returning to a library releases the source reader before changing modes', async () => {
  const ipc = makeIpc(); const calls = [];
  registerLibraryIpc(ipc, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/synthetic/library'] }) },
    settings: { getLibraryPath: async () => null, setLibraryPath: async () => {} },
    loadLibrary: async () => ({ sessions: [] }),
    releaseSourceReader: async () => { await Promise.resolve(); calls.push('closed'); },
    sourceState: { useLibrary: () => calls.push('library') },
  });
  await ipc.invoke(CHANNELS.LOAD);
  assert.deepEqual(calls, ['closed', 'library']);
  calls.length = 0;
  await ipc.invoke(CHANNELS.CHOOSE);
  assert.deepEqual(calls, ['closed', 'library']);
});
