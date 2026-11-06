'use strict';
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function pageFailure(error) {
  const reasons = { DECOMPRESSION_FAILED: 'decompression-failed', DECOMPRESSION_LIMIT: 'decompression-limit', SOURCE_CHANGED: 'source-changed', RECORD_TOO_LARGE: 'record-too-large',
    MESSAGE_TOO_LARGE: 'message-too-large', PLATFORM_UNSUPPORTED: 'platform-unsupported',
    READ_CANCELLED: 'cancelled', STALE_READER: 'stale-reader', READ_TIMEOUT: 'read-timeout' };
  return { ok: false, reason: reasons[error && error.code] || 'invalid-file' };
}
function registerCodexPageIpc(ipc, { reader, sourceState }) {
  ipc.handle('codexPage:move', async (_event, readerId, direction) => {
    const source = reader.getSource();
    const entry = sourceState.getSelectedFolderEntry();
    const matches = source && source.mode === sourceState.getMode() && (source.mode === 'codex'
      ? source.filePath === sourceState.getCodexPath()
      : entry && entry.entryId === source.entryId && entry.generation === source.generation);
    if (!matches) return { ok: false, reason: 'stale-reader' };
    try { return { ok: true, session: await reader.move(readerId, direction) }; }
    catch (error) { return pageFailure(error); }
  }, { validateArgs: args => args.length === 2 && typeof args[0] === 'string' &&
    OPAQUE_ID.test(args[0]) && ['next', 'previous', 'latest', 'first'].includes(args[1]) });
  ipc.handle('codexPage:cancel', async () => ({ ok: await reader.cancel() }), { allowWhileBusy: true });
}
module.exports = { registerCodexPageIpc, pageFailure };
