'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createZstdSession } = require('../../lib/codex-page-zstd-stream');
let session = null;
parentPort.on('message', async data => {
  try {
    const offset = data.offset || 0;
    if (!session || offset !== session.cursor || offset === 0) {
      await session?.close(); session = null;
      session = await createZstdSession({ ...workerData, snapshot: data.snapshot });
    }
    const result = await session.read(offset, data.snapshot);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    await session?.close().catch(() => {}); session = null;
    parentPort.postMessage({ ok: false, code: [
      'SOURCE_CHANGED', 'RECORD_TOO_LARGE', 'MESSAGE_TOO_LARGE', 'PLATFORM_UNSUPPORTED',
      'DECOMPRESSION_FAILED', 'DECOMPRESSION_LIMIT',
    ].includes(error.code) ? error.code : 'INVALID_SOURCE' });
  }
});
