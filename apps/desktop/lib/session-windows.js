'use strict';

// One global IPC registration, with capabilities and jobs owned by each window.
function createWindowRouter(ipcMain) {
  const windows = new Map(), channels = new Set();
  return {
    attach(sender) {
      if (windows.has(sender)) throw new Error('Window already registered');
      const handlers = new Map();
      windows.set(sender, handlers);
      return { handle(channel, handler) {
        if (handlers.has(channel)) throw new Error('Duplicate window handler');
        handlers.set(channel, handler);
        if (channels.has(channel)) return;
        channels.add(channel);
        ipcMain.handle(channel, (event, ...args) => {
          const target = windows.get(event.sender)?.get(channel);
          return target ? target(event, ...args) : { ok: false, reason: 'invalid-request' };
        });
      } };
    },
    detach(sender) { windows.delete(sender); },
  };
}

// Remember defaults on disk, but never redirect another window's source.
function createWindowSettings(shared, initial) {
  let ready;
  const read = () => ready ||= initial ? Promise.resolve(structuredClone(initial)) :
    Promise.all([shared.getSource(), shared.getLibraryPath()]).then(([source, libraryPath]) => ({ source, libraryPath }));
  return {
    getSource: async () => ({ ...(await read()).source }),
    getLibraryPath: async () => (await read()).libraryPath,
    async setCodexPath(value) {
      const state = await read();
      state.source = { kind: 'codex', path: value };
      await shared.setCodexPath(value);
    },
    async setLibraryPath(value) {
      await shared.setLibraryPath(value);
      const state = await read();
      state.libraryPath = value; state.source = { ...state.source, kind: 'library' };
    },
    snapshot: async () => structuredClone(await read()),
  };
}
module.exports = { createWindowRouter, createWindowSettings };
