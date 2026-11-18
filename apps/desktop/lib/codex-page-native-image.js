'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { inspectLocalImage, MAX_IMAGE_BYTES } = require('./session-viewer/local-image-preview');
const fail = reason => Object.assign(new Error(reason), { reason });
const MAX_ENCODED = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32;

async function replay({ source, snapshot, attachment }) {
  const { createZstdSession } = require('./codex-page-zstd-stream');
  if (attachment.length > MAX_ENCODED) throw fail('large-image');
  let parts = [], length = 0, found = false;
  const stream = await createZstdSession({ ...source, snapshot }, {
    allowPlain: true, projectConversation: true,
    projectionOptions: record => {
      let field = 0;
      return {
        createText: () => ({ write() {}, finish() {} }),
        createImage() {
          const selected = record === attachment.record && field++ === attachment.field;
          return {
            write(text) {
              if (!selected) return;
              length += text.length;
              if (length > MAX_ENCODED) throw fail('large-image');
              parts.push(text);
            },
            finish() { if (selected) found = true; },
          };
        },
      };
    },
  });
  try {
    for await (const record of stream.rawRecords()) { void record; }
    await stream.verify();
    if (!found || length !== attachment.length) throw fail('changed-image');
    const encoded = parts.join(''); parts = [];
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(encoded);
    if (!match || !match[2].length || match[2].length % 4) throw fail('unsupported-image');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw fail('large-image');
    if (bytes.toString('base64') !== match[2]) throw fail('unsupported-image');
    let info;
    try { info = inspectLocalImage(bytes); }
    catch (error) { throw fail(error.reason === 'pixel-limit' ? 'pixel-limit' : 'unsupported-image'); }
    if (info.mime !== 'image/' + match[1]) throw fail('unsupported-image');
    return { bytes, ...info };
  } finally { await stream.close(); }
}

function readEmbeddedImage(reference) {
  if (reference.attachment.length > MAX_ENCODED) return Promise.reject(fail('large-image'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: reference, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96 } });
    let result, error;
    const timer = setTimeout(() => { error = fail('unavailable-image'); void worker.terminate(); }, 30000);
    worker.on('message', message => { result = message; });
    worker.on('error', () => { error = fail('unavailable-image'); });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (error || code || !result) reject(error || fail('unavailable-image'));
      else if (!result.ok) reject(fail(result.reason));
      else resolve({ ...result.value, bytes: Buffer.from(result.value.bytes) });
    });
  });
}
if (!isMainThread) replay(workerData).then(value => parentPort.postMessage({ ok: true, value }), error =>
  parentPort.postMessage({ ok: false, reason: error.reason || (error.code === 'SOURCE_CHANGED' ? 'changed-image' : 'unavailable-image') }));
module.exports = { readEmbeddedImage };
