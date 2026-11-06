'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const MODULE_REL = '../../lib/session-import-ipc.js';

function loadModule() {
  delete require.cache[require.resolve(MODULE_REL)];
  return require(MODULE_REL);
}

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

function makeImporters() {
  const calls = { claude: [], codex: [] };
  return {
    calls,
    importers: {
      async runClaudeImport(options) {
        calls.claude.push(options);
        return { imported: 1, skipped: 0, errors: 0 };
      },
      async runCodexImport(options) {
        calls.codex.push(options);
        return { imported: 1, skipped: 0, errors: 0 };
      },
    },
  };
}

test('refresh uses the main-owned library and writes directly below it', async () => {
  const ipc = makeIpc();
  const { calls, importers } = makeImporters();
  const selectedLibrary = path.join(os.tmpdir(), 'selected-library');
  loadModule().register(ipc, {
    importers,
    getLibraryPath: async () => selectedLibrary,
  });

  const result = await ipc.invoke('sessionViewer:import', {
    libraryPath: path.join(os.tmpdir(), 'renderer-controlled-path'),
    vaultPath: path.join(os.tmpdir(), 'legacy-vault-path'),
  });

  assert.equal(result.ok, true);
  assert.equal(
    calls.claude[0].outputBase,
    path.join(selectedLibrary, 'claude-code'),
  );
  assert.equal(
    calls.codex[0].outputBase,
    path.join(selectedLibrary, 'codex'),
  );
  assert.equal(
    calls.claude[0].sourceRoot,
    path.join(os.homedir(), '.claude', 'projects'),
  );
  assert.equal(
    calls.codex[0].sourceRoot,
    path.join(os.homedir(), '.codex', 'sessions'),
  );
});

test('refresh fails before invoking importers when no library is selected', async () => {
  const ipc = makeIpc();
  const { calls, importers } = makeImporters();
  loadModule().register(ipc, {
    importers,
    getLibraryPath: async () => null,
  });

  const result = await ipc.invoke('sessionViewer:import', {
    libraryPath: '/renderer/cannot/choose',
  });

  assert.deepEqual(result, { ok: false, reason: 'no-library' });
  assert.equal(calls.claude.length, 0);
  assert.equal(calls.codex.length, 0);
});
