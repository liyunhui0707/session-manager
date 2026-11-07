'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');

test('preload exposes only narrow session-manager calls and passes only an opaque folder entry ID', async () => {
  const invocations = [];
  const exposed = {};
  const sandbox = {
    require(id) {
      assert.equal(id, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) { exposed[name] = value; },
        },
        ipcRenderer: {
          invoke(channel, ...args) {
            invocations.push({ channel, args });
            return Promise.resolve(channel);
          },
        },
      };
    },
  };

  vm.runInNewContext(source, sandbox, { filename: 'preload.js' });
  assert.deepEqual(Object.keys(exposed), ['sessionApi']);
  assert.deepEqual(Object.keys(exposed.sessionApi).sort(), [
    'cancelCodexFolderScan',
    'cancelCodexPage',
    'cancelCodexSearch',
    'chooseCodexFile',
    'chooseCodexFolder',
    'chooseLibrary',
    'codexSearchProgress',
    'getSelectedLibrary',
    'getWindowInitial',
    'loadCodexCatalogEntry',
    'loadSessions',
    'moreCodexSearch',
    'moveCodexPage',
    'newWindow',
    'openCodexSearchHit',
    'readCodexImage',
    'refreshSessions',
    'reloadCodexCatalogEntry',
    'reloadCodexFile',
    'rescanCodexFolder',
    'restoreCodexFolder',
    'searchCodexConversations',
    'showSessionMenu',
    'syncCodexConversation',
  ]);

  await exposed.sessionApi.getSelectedLibrary('/ignored');
  await exposed.sessionApi.chooseLibrary('/ignored');
  await exposed.sessionApi.loadSessions('/ignored');
  await exposed.sessionApi.refreshSessions('/ignored');
  await exposed.sessionApi.chooseCodexFile('/ignored');
  await exposed.sessionApi.reloadCodexFile('/ignored');
  await exposed.sessionApi.chooseCodexFolder('/ignored');
  await exposed.sessionApi.rescanCodexFolder('/ignored');
  await exposed.sessionApi.cancelCodexFolderScan('/ignored');
  await exposed.sessionApi.loadCodexCatalogEntry('11111111-1111-4111-8111-111111111111', '/ignored');
  await exposed.sessionApi.reloadCodexCatalogEntry('/ignored');
  await exposed.sessionApi.moveCodexPage('11111111-1111-4111-8111-111111111111', 'next', '/ignored');
  await exposed.sessionApi.cancelCodexPage('/ignored');
  await exposed.sessionApi.syncCodexConversation('/ignored');
  await exposed.sessionApi.searchCodexConversations('needle', 'all', '/ignored');
  await exposed.sessionApi.moreCodexSearch('11111111-1111-4111-8111-111111111111', '/ignored');
  await exposed.sessionApi.openCodexSearchHit('11111111-1111-4111-8111-111111111111', '/ignored');
  await exposed.sessionApi.cancelCodexSearch('/ignored');
  await exposed.sessionApi.codexSearchProgress('/ignored');
  const image = { readerId: '11111111-1111-4111-8111-111111111111', page: 1, message: 0, image: 0, size: 'preview' };
  await exposed.sessionApi.readCodexImage(image, '/ignored');

  await exposed.sessionApi.getWindowInitial('/ignored');
  await exposed.sessionApi.newWindow('/ignored');
  const target = { kind: 'folder', id: '11111111-1111-4111-8111-111111111111' };
  await exposed.sessionApi.showSessionMenu(target, '/ignored');
  assert.deepEqual(invocations, [
    { channel: 'sessionLibrary:get-selected', args: [] },
    { channel: 'sessionLibrary:choose', args: [] },
    { channel: 'sessionLibrary:load', args: [] },
    { channel: 'sessionViewer:import', args: [] },
    { channel: 'codexFile:choose', args: [] },
    { channel: 'codexFile:reload', args: [] },
    { channel: 'codexFolder:choose', args: [] },
    { channel: 'codexFolder:rescan', args: [] },
    { channel: 'codexFolder:cancel', args: [] },
    { channel: 'codexFolder:load', args: ['11111111-1111-4111-8111-111111111111'] },
    { channel: 'codexFolder:reload', args: [] },
    { channel: 'codexPage:move', args: ['11111111-1111-4111-8111-111111111111', 'next'] },
    { channel: 'codexPage:cancel', args: [] },
    { channel: 'codexConversation:sync', args: [] },
    { channel: 'codexConversation:search', args: ['needle', 'all'] },
    { channel: 'codexConversation:search-more', args: ['11111111-1111-4111-8111-111111111111'] },
    { channel: 'codexConversation:open-hit', args: ['11111111-1111-4111-8111-111111111111'] },
    { channel: 'codexConversation:cancel-search', args: [] },
    { channel: 'codexConversation:search-progress', args: [] },
    { channel: 'codexImage:read', args: [image] },
    { channel: 'sessionWindow:initial', args: [] },
    { channel: 'sessionWindow:new', args: [] },
    { channel: 'sessionWindow:menu', args: [target] },
  ]);
});
