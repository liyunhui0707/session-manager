'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const { readOrigin } = require('./codex-page-origin');
(async () => {
  const results = [];
  for (const { source, cached } of workerData.entries) results.push(await readOrigin(source, cached));
  parentPort.postMessage(results);
})().catch(() => { process.exitCode = 1; });
