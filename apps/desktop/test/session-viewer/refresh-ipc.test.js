'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const MODULE_REL = '../../lib/session-import-ipc.js';

function loadModule() {
  delete require.cache[require.resolve(MODULE_REL)];
  return require(MODULE_REL);
}

function makeMockIpc() {
  const handlers = {};
  return {
    handle(channel, fn) { handlers[channel] = fn; },
    invoke(channel, payload) { return handlers[channel]({}, payload); },
  };
}

function makeMockImporters() {
  const calls = { claude: [], codex: [] };
  let claudeImpl = async () => ({ imported: 0, skipped: 0, errors: 0 });
  let codexImpl = async () => ({ imported: 0, skipped: 0, errors: 0 });
  return {
    calls,
    setClaudeImpl(fn) { claudeImpl = fn; },
    setCodexImpl(fn) { codexImpl = fn; },
    runClaudeImport: async (args) => {
      calls.claude.push(args);
      return claudeImpl(args);
    },
    runCodexImport: async (args) => {
      calls.codex.push(args);
      return codexImpl(args);
    },
  };
}

function register(options = {}) {
  const ipc = makeMockIpc();
  const mock = makeMockImporters();
  const libraryPath = options.libraryPath === undefined ? '/session-library' : options.libraryPath;
  loadModule().register(ipc, {
    importers: {
      runClaudeImport: mock.runClaudeImport,
      runCodexImport: mock.runCodexImport,
    },
    getLibraryPath: async () => libraryPath,
  });
  return { ipc, mock };
}

test('refresh uses only the main-owned library and writes directly to agent folders', async () => {
  const { ipc, mock } = register({ libraryPath: '/chosen/library' });
  const result = await ipc.invoke('sessionViewer:import', {
    libraryPath: '/renderer/must-not-control-this',
    vaultPath: '/legacy/must-not-control-this',
  });

  assert.equal(result.ok, true);
  assert.equal(mock.calls.claude[0].outputBase, path.join('/chosen/library', 'claude-code'));
  assert.equal(mock.calls.codex[0].outputBase, path.join('/chosen/library', 'codex'));
  assert.equal(mock.calls.claude[0].sourceRoot, path.join(os.homedir(), '.claude', 'projects'));
  assert.equal(mock.calls.codex[0].sourceRoot, path.join(os.homedir(), '.codex', 'sessions'));
});

test('missing selected library returns a typed response without invoking importers', async () => {
  for (const libraryPath of [null, '', 0]) {
    const { ipc, mock } = register({ libraryPath });
    const result = await ipc.invoke('sessionViewer:import', { libraryPath: '/renderer-value' });
    assert.deepEqual(result, { ok: false, reason: 'no-library' });
    assert.equal(mock.calls.claude.length, 0);
    assert.equal(mock.calls.codex.length, 0);
  }
});

test('successful refresh returns both importer summaries', async () => {
  const { ipc, mock } = register();
  mock.setClaudeImpl(async () => ({ imported: 3, skipped: 1, errors: 0, outputs: ['/private/synthetic-output.md'], note: 'sensitive detail' }));
  mock.setCodexImpl(async () => ({ imported: 2, skipped: 0, errors: 0 }));

  assert.deepEqual(await ipc.invoke('sessionViewer:import'), {
    ok: true,
    claude: { ok: true, imported: 3, skipped: 1, errors: 0 },
    codex: { ok: true, imported: 2, skipped: 0, errors: 0 },
  });
});

test('refresh is single-flight and releases its lock after completion', async () => {
  const { ipc, mock } = register();
  let release;
  mock.setClaudeImpl(() => new Promise((resolve) => { release = resolve; }));

  const first = ipc.invoke('sessionViewer:import');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await ipc.invoke('sessionViewer:import'), { ok: false, reason: 'in-progress' });
  release({ imported: 1, skipped: 0, errors: 0 });
  assert.equal((await first).ok, true);

  mock.setClaudeImpl(async () => ({ imported: 2, skipped: 0, errors: 0 }));
  assert.equal((await ipc.invoke('sessionViewer:import')).ok, true);
});

test('lock stays held until both importers settle when one rejects', async () => {
  const { ipc, mock } = register();
  let releaseCodex;
  mock.setClaudeImpl(async () => { throw new Error('failed'); });
  mock.setCodexImpl(() => new Promise((resolve) => { releaseCodex = resolve; }));

  const first = ipc.invoke('sessionViewer:import');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await ipc.invoke('sessionViewer:import'), { ok: false, reason: 'in-progress' });
  releaseCodex({ imported: 0, skipped: 0, errors: 0 });
  assert.deepEqual(await first, {
    ok: false, reason: 'import-error',
    claude: { ok: false, reason: 'import-error' },
    codex: { ok: true, imported: 0, skipped: 0, errors: 0 },
  });
});

test('import errors are typed and never leak absolute paths', async () => {
  const { ipc, mock } = register();
  mock.setClaudeImpl(async () => {
    throw new Error("EACCES, open '/Users/test/.claude/projects/private.jsonl'");
  });

  const result = await ipc.invoke('sessionViewer:import');
  assert.deepEqual(result, {
    ok: false, reason: 'import-error',
    claude: { ok: false, reason: 'import-error' },
    codex: { ok: true, imported: 0, skipped: 0, errors: 0 },
  });
  assert.equal(JSON.stringify(result).includes('/Users/'), false);
});

test('unsupported symlink-safe reads receive their dedicated typed reason', async () => {
  const { ipc, mock } = register();
  mock.setClaudeImpl(async () => {
    throw new Error('symlink-safe reads unsupported on this platform: O_NOFOLLOW unavailable');
  });

  assert.deepEqual(await ipc.invoke('sessionViewer:import'), {
    ok: false,
    reason: 'platform-unsupported',
    claude: { ok: false, reason: 'platform-unsupported' },
    codex: { ok: true, imported: 0, skipped: 0, errors: 0 },
  });
});

test('resolved per-file errors are not reported as a successful refresh', async () => {
  const { ipc, mock } = register();
  mock.setClaudeImpl(async () => ({ imported: 2, skipped: 1, errors: 3 }));
  mock.setCodexImpl(async () => ({ imported: 4, skipped: 0, errors: 0 }));
  assert.deepEqual(await ipc.invoke('sessionViewer:import'), {
    ok: false, reason: 'import-error',
    claude: { ok: false, reason: 'import-error', imported: 2, skipped: 1, errors: 3 },
    codex: { ok: true, imported: 4, skipped: 0, errors: 0 },
  });
});

test('Codex rejection retains Claude counts; two rejections retain both sanitized failures', async () => {
  const { ipc, mock } = register();
  mock.setClaudeImpl(async () => ({ imported: 3, skipped: 0, errors: 0 }));
  mock.setCodexImpl(async () => { throw new Error('private rejected path'); });
  const partial = await ipc.invoke('sessionViewer:import');
  assert.equal(partial.claude.imported, 3);
  assert.deepEqual(partial.codex, { ok: false, reason: 'import-error' });
  mock.setClaudeImpl(async () => { throw new Error('another private path'); });
  assert.deepEqual(await ipc.invoke('sessionViewer:import'), {
    ok: false, reason: 'import-error',
    claude: { ok: false, reason: 'import-error' },
    codex: { ok: false, reason: 'import-error' },
  });
});

test('only the no-source note is forwarded and missing stores remain successful', async () => {
  const { ipc, mock } = register();
  mock.setCodexImpl(async () => ({ imported: 0, skipped: 0, errors: 0, note: 'no-source', outputs: [] }));
  const result = await ipc.invoke('sessionViewer:import');
  assert.equal(result.ok, true);
  assert.deepEqual(result.codex, { ok: true, imported: 0, skipped: 0, errors: 0, note: 'no-source' });
});

test('invalid summary counts fail safely without forwarding arbitrary values', async () => {
  for (const value of [-1, NaN, Infinity, 'private-value', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { ipc, mock } = register();
    mock.setCodexImpl(async () => ({ imported: value, skipped: 0, errors: 0 }));
    const result = await ipc.invoke('sessionViewer:import');
    assert.equal(result.ok, false);
    assert.deepEqual(result.codex, { ok: false, reason: 'import-error' });
  }
});

test('Claude and Codex importers start in parallel', async () => {
  const { ipc, mock } = register();
  let releaseClaude;
  let releaseCodex;
  mock.setClaudeImpl(() => new Promise((resolve) => { releaseClaude = resolve; }));
  mock.setCodexImpl(() => new Promise((resolve) => { releaseCodex = resolve; }));

  const refresh = ipc.invoke('sessionViewer:import');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(mock.calls.claude.length, 1);
  assert.equal(mock.calls.codex.length, 1);
  releaseClaude({ imported: 0, skipped: 0, errors: 0 });
  releaseCodex({ imported: 0, skipped: 0, errors: 0 });
  assert.equal((await refresh).ok, true);
});

test('a synchronous importer failure still waits for the other agent and holds the lock', async () => {
  const ipc = makeMockIpc();
  let release;
  let started;
  const codexStarted = new Promise((resolve) => { started = resolve; });
  loadModule().register(ipc, {
    getLibraryPath: async () => '/synthetic/library',
    importers: {
      runClaudeImport() { throw new Error('private synchronous failure'); },
      runCodexImport() { started(); return new Promise((resolve) => { release = resolve; }); },
    },
  });
  const first = ipc.invoke('sessionViewer:import');
  await Promise.race([codexStarted, first.then(() => { throw new Error('returned before starting Codex'); })]);
  assert.deepEqual(await ipc.invoke('sessionViewer:import'), { ok: false, reason: 'in-progress' });
  release({ imported: 1, skipped: 0, errors: 0 });
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.codex.imported, 1);
});
