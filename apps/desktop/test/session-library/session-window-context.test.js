'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createWindowContext } = require('../../lib/session-window-context');
const { createWindowRouter } = require('../../lib/session-windows');
const { createLibrarySettings } = require('../../lib/session-library-settings');

test('production window contexts keep catalog, reader and search capabilities private', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-windows-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'sessions/2026/11/01'); await fs.mkdir(dir, { recursive: true });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
  const file = path.join(dir, `rollout-2026-11-01T00-00-00-${id}.jsonl`);
  const body = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic window needle' } }) + '\n';
  await fs.writeFile(file, body);
  const handlers = new Map(), router = createWindowRouter({ handle: (key, fn) => handlers.set(key, fn) });
  const sharedSettings = createLibrarySettings({ settingsPath: path.join(root, 'settings.json') });
  const windows = [];
  function make(initial) {
    const indexPath = '/synthetic/index.html'; let destroyed = false, click, child;
    const window = { webContents: { mainFrame: { url: pathToFileURL(indexPath).href } }, isDestroyed: () => destroyed };
    const context = createWindowContext({ window, ipc: router.attach(window.webContents), sharedSettings,
      indexPath, defaultRoot: root, initial,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
      showMenu: fn => { click = fn; }, openWindow: seed => { child = seed; },
    });
    const invoke = (channel, ...args) => handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
    const result = { context, invoke, menu: () => click(), child: () => child,
      async close() { destroyed = true; router.detach(window.webContents); await context.dispose(); } };
    windows.push(result); return result;
  }
  t.after(async () => { for (const win of windows) await win.close(); });
  const a = make(), b = make();
  const ca = (await a.invoke('codexFolder:choose')).catalog;
  const cb = (await b.invoke('codexFolder:choose')).catalog;
  assert.notEqual(ca.entries[0].entryId, cb.entries[0].entryId);
  assert.equal((await b.invoke('codexFolder:load', ca.entries[0].entryId)).ok, false);
  const ra = await a.invoke('codexFolder:load', ca.entries[0].entryId);
  const rb = await b.invoke('codexFolder:load', cb.entries[0].entryId);
  assert.equal(ra.ok, true); assert.equal(rb.ok, true);
  assert.equal((await b.invoke('codexPage:move', ra.session.page.readerId, 'latest')).ok, false);
  const search = await a.invoke('codexConversation:search', 'needle', 'all');
  assert.equal(search.hits.length, 1);
  assert.equal((await b.invoke('codexConversation:open-hit', search.hits[0].hitId)).ok, false);
  assert.equal((await a.invoke('sessionWindow:menu', { kind: 'folder', id: '/arbitrary/path' })).ok, false);
  assert.equal((await a.invoke('sessionWindow:menu', { kind: 'folder', id: ca.entries[0].entryId })).ok, true);
  a.menu();
  assert.deepEqual(a.child().target, { kind: 'folder', id });
  assert.equal(a.child().settings.source.path, root);
  const c = make(a.child());
  assert.deepEqual((await c.invoke('sessionWindow:initial')).target, { kind: 'folder', id });
  await a.close();
  assert.equal((await a.invoke('codexPage:cancel')).ok, false);
  assert.equal((await b.invoke('codexFile:reload')).reason, 'no-source');
  assert.equal((await b.invoke('codexPage:move', rb.session.page.readerId, 'latest')).ok, true);
  assert.equal(await fs.readFile(file, 'utf8'), body);
});
