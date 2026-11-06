'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { readCodexPage } = require('./codex-page-read');
readCodexPage(workerData).then(
  result => parentPort.postMessage({ ok: true, result }),
  error => parentPort.postMessage({ ok: false, code: [
    'SOURCE_CHANGED', 'RECORD_TOO_LARGE', 'MESSAGE_TOO_LARGE', 'PLATFORM_UNSUPPORTED',
  ].includes(error.code) ? error.code : 'INVALID_SOURCE' }),
);
