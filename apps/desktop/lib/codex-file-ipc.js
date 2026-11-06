'use strict';

const { loadCodexFile } = require('./codex-file');
const { pageFailure } = require('./codex-page-ipc');

function fileFailure(error) {
  if (error && ['DECOMPRESSION_FAILED', 'DECOMPRESSION_LIMIT', 'SOURCE_CHANGED', 'RECORD_TOO_LARGE', 'MESSAGE_TOO_LARGE', 'PLATFORM_UNSUPPORTED', 'READ_CANCELLED', 'READ_TIMEOUT'].includes(error.code)) return pageFailure(error);
  const reason = error && error.code === 'OVER_CAP' ? 'over-cap'
    : error && typeof error.message === 'string' && error.message.startsWith('symlink-safe reads unsupported on this platform')
      ? 'platform-unsupported' : 'invalid-file';
  return { ok: false, reason };
}

function registerCodexFileIpc(ipc, { dialog, sourceState, loadFile = loadCodexFile }) {
  ipc.handle('codexFile:choose', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '打开 Codex 会话文件',
        properties: ['openFile'],
        filters: [{ name: 'Codex 会话（JSONL 或 Zstd）', extensions: ['jsonl', 'zst'] }],
      });
      const filePath = result && result.filePaths && result.filePaths[0];
      if (!result || result.canceled || !filePath) return { ok: false, reason: 'cancelled' };
      const session = await loadFile(filePath);
      sourceState.useCodex(filePath);
      return { ok: true, session };
    } catch (error) { return fileFailure(error); }
  });
  ipc.handle('codexFile:reload', async () => {
    const filePath = sourceState.getCodexPath();
    if (!filePath) return { ok: false, reason: 'no-source' };
    try { return { ok: true, session: await loadFile(filePath) }; }
    catch (error) { return fileFailure(error); }
  });
}

module.exports = { registerCodexFileIpc };
