'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const appRoot = path.join(__dirname, '../..');
const mainRequire = createRequire(path.join(appRoot, 'main.js'));

test('production choose, automatic sync and full-text search exclude reviews and subagents', async t => {
  const fsp = require('node:fs/promises');
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'asm-main-origin-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const active = path.join(root, 'sessions/2026/11/04'); await fsp.mkdir(active, { recursive: true });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const files = ids.map(id => path.join(active, `rollout-2026-11-04T00-00-00-${id}.jsonl`));
  const body = (id, source) => JSON.stringify({ type: 'session_meta', payload: { id, source } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'unique test words' } }) + '\n';
  await fsp.writeFile(files[0], body(ids[0], { subagent: { other: 'guardian' } }));
  await fsp.writeFile(files[1], body(ids[1], 'cli'));
  await fsp.writeFile(files[2], body(ids[2], { subagent: { thread_spawn: { parent_thread_id: ids[1], depth: 1 } } }));
  await fsp.writeFile(files[3], body(ids[3], 'exec'));
  const handlers = new Map(); let window;
  class BrowserWindow {
    constructor() { window = this; this.webContents = { mainFrame: { url: pathToFileURL(path.join(appRoot, 'index.html')).href }, setWindowOpenHandler() {}, on() {} }; }
    isDestroyed() { return false; } removeMenu() {} loadFile() {} once() {} on() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8'), {
    __dirname: appRoot, process: { platform: 'darwin' }, require(id) {
      if (id === 'electron') return { BrowserWindow, app: { whenReady: () => Promise.resolve(), getPath: () => root, on() {} },
        ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) } };
      if (id === './lib/session-library-settings') return { createLibrarySettings: () => ({ getLibraryPath: async () => null, setLibraryPath() {} }) };
      return mainRequire(id);
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const chosen = await handlers.get('codexFolder:choose')(event);
  assert.equal(chosen.ok, true);
  assert.deepEqual(chosen.catalog.entries.map(e => e.sessionId), [ids[1]]);
  const search = await handlers.get('codexConversation:search')(event, 'unique test words', 'all');
  assert.equal(search.total, 1); assert.equal(search.hits.length, 1);
  await fsp.writeFile(files[1], body(ids[1], 'exec'));
  const synced = await handlers.get('codexConversation:sync')(event);
  assert.equal(synced.changed, true); assert.equal(synced.catalog.entries.length, 0);
});

test('production main accepts only the current window main frame at the exact index URL', async () => {
  const handlers = new Map();
  let window, touched = 0;
  const indexUrl = pathToFileURL(path.join(appRoot, 'index.html')).href;
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: indexUrl }, setWindowOpenHandler() {}, on() {} };
    }
    isDestroyed() { return false; }
    removeMenu() {} loadFile() {} once() {} on() {}
  }
  const electron = {
    BrowserWindow,
    app: { whenReady: () => Promise.resolve(), getPath: () => '/synthetic/profile', on() {} },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => { touched++; return { canceled: true }; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8'), {
    __dirname: appRoot, process: { platform: 'darwin' },
    require(id) {
      if (id === 'electron') return electron;
      if (id === './lib/session-library-settings') return { createLibrarySettings: () => ({ getLibraryPath: async () => { touched++; return null; }, setLibraryPath() {} }) };
      if (id === './lib/session-library') return { loadSessionLibrary() { throw new Error('No filesystem reads allowed'); } };
      return mainRequire(id);
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handlers.size, 21);
  for (const handler of handlers.values()) {
    for (const event of [{}, { sender: {}, senderFrame: window.webContents.mainFrame }, { sender: window.webContents, senderFrame: { url: indexUrl } }]) {
      assert.equal((await handler(event)).reason, 'invalid-request');
    }
    for (const url of ['https://example.invalid/', indexUrl + '#other', indexUrl + '?other']) {
      window.webContents.mainFrame.url = url;
      assert.equal((await handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).reason, 'invalid-request');
    }
    window.webContents.mainFrame.url = indexUrl;
    assert.equal((await handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'injected')).reason, 'invalid-request');
  }
  assert.equal(touched, 0);
  assert.equal((await handlers.get('sessionLibrary:get-selected')({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).ok, true);
  assert.equal(touched, 1);
});
