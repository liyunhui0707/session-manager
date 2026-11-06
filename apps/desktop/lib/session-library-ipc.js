'use strict';

const CHANNELS = Object.freeze({
  GET_SELECTED: 'sessionLibrary:get-selected',
  CHOOSE: 'sessionLibrary:choose',
  LOAD: 'sessionLibrary:load',
});

function registerLibraryIpc(ipc, options) {
  const sourceState = options && options.sourceState;
  const dialog = options && options.dialog;
  const settings = options && options.settings;
  const loadLibrary = options && options.loadLibrary;
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('session-library-ipc: ipc.handle is required');
  }
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    throw new Error('session-library-ipc: dialog is required');
  }
  if (
    !settings ||
    typeof settings.getLibraryPath !== 'function' ||
    typeof settings.setLibraryPath !== 'function'
  ) {
    throw new Error('session-library-ipc: settings are required');
  }
  if (typeof loadLibrary !== 'function') {
    throw new Error('session-library-ipc: loadLibrary is required');
  }

  ipc.handle(CHANNELS.GET_SELECTED, async () => ({
    ok: true,
    libraryPath: await settings.getLibraryPath(),
  }));

  ipc.handle(CHANNELS.CHOOSE, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Markdown 会话库',
      properties: ['openDirectory'],
    });
    const libraryPath = result && result.filePaths && result.filePaths[0];
    if (result && result.canceled || !libraryPath) {
      return { ok: false, reason: 'cancelled' };
    }
    try {
      const { sessions, skippedFiles } = await loadLibrary(libraryPath);
      await settings.setLibraryPath(libraryPath);
      await options.releaseSourceReader?.();
      if (sourceState) sourceState.useLibrary();
      return { ok: true, libraryPath, sessions, skippedFiles };
    } catch {
      return { ok: false, reason: 'invalid-library' };
    }
  });

  ipc.handle(CHANNELS.LOAD, async () => {
    const libraryPath = await settings.getLibraryPath();
    if (!libraryPath) {
      await options.releaseSourceReader?.();
      if (sourceState) sourceState.useLibrary();
      return { ok: false, reason: 'no-library' };
    }
    try {
      const { sessions, skippedFiles } = await loadLibrary(libraryPath);
      await options.releaseSourceReader?.();
      if (sourceState) sourceState.useLibrary();
      return { ok: true, libraryPath, sessions, skippedFiles };
    } catch {
      return { ok: false, reason: 'invalid-library' };
    }
  });
}

module.exports = { CHANNELS, registerLibraryIpc };
