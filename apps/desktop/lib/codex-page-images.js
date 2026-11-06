'use strict';
const fs = require('node:fs/promises'), { constants } = require('node:fs');
const path = require('node:path'), os = require('node:os');
const { inspectLocalImage, MAX_IMAGE_BYTES } = require('./session-viewer/local-image-preview');
const fail = reason => Object.assign(new Error(reason), { reason });
const within = (file, root) => file.startsWith(root + path.sep);
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

async function readImage(reference, tempRoot) {
  const input = reference.path, root = reference.source.canonicalRoot;
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || !path.isAbsolute(input) ||
      path.resolve(input) !== input || !/\.(png|jpe?g)$/i.test(input)) throw fail('restricted-image');
  const canonicalTemp = await fs.realpath(tempRoot);
  let file = input;
  // macOS /var is an OS alias. Only normalize this known temporary root; never
  // resolve arbitrary transcript-provided symlinks into an allowed directory.
  if (within(input, tempRoot)) file = canonicalTemp + input.slice(tempRoot.length);
  const clipboard = path.dirname(file) === canonicalTemp && /^codex-clipboard-[\w-]+\.(png|jpe?g)$/i.test(path.basename(file));
  if (!within(file, root) && !clipboard) throw fail('restricted-image');
  if (!clipboard && path.relative(root, file).split(path.sep).some(part => part.startsWith('.') || part === 'secrets')) throw fail('restricted-image');
  const { validateAncestorChain } = await import('../tools/session-import/lib/output-root.mjs');
  try { await validateAncestorChain(file); } catch { throw fail('restricted-image'); }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fail('restricted-image');
    if (before.size > MAX_IMAGE_BYTES) throw fail('large-image');
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    await validateAncestorChain(file);
    if (read !== bytes.length || await fs.realpath(file) !== file || !same(before, await handle.stat()) ||
        !same(before, await fs.stat(file))) throw fail('changed-image');
    let info;
    try { info = inspectLocalImage(bytes); } catch (error) { throw fail(error.reason === 'pixel-limit' ? 'pixel-limit' : 'unsupported-image'); }
    return { bytes, ...info };
  } finally { await handle.close(); }
}
function registerConversationImages(ipc, { reader, sourceState, thumbnail, tempRoot = os.tmpdir().replace(/\/$/, '') }) {
  let imageBusy = false;
  function reference(request) {
    const ref = reader.getImageReference(request), source = ref?.source;
    if (!source || source.mode !== sourceState.getMode()) return null;
    const entry = sourceState.getSelectedFolderEntry();
    return source.mode === 'codex' ? (source.filePath === sourceState.getCodexPath() ? ref : null)
      : (entry && source.entryId === entry.entryId && source.generation === entry.generation ? ref : null);
  }
  ipc.handle('codexImage:read', async (_event, request) => {
    if (imageBusy) return { ok: false, reason: 'in-progress' };
    const ref = reference(request);
    if (!ref) return { ok: false, reason: 'stale-image' };
    imageBusy = true;
    try {
      const result = await readImage(ref, tempRoot);
      if (request.size === 'preview') {
        result.bytes = await thumbnail(result.bytes); result.mime = 'image/png';
        if (!result.bytes?.length || result.bytes.length > MAX_IMAGE_BYTES) throw fail('unsupported-image');
      }
      if (reference(request)?.source !== ref.source) throw fail('stale-image');
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, reason: error.reason || (error.code === 'ENOENT' ? 'missing-image' : 'unavailable-image') };
    } finally { imageBusy = false; }
  }, { allowWhileBusy: true, validateArgs: args => {
    const r = args[0];
    return args.length === 1 && r && Object.keys(r).length === 5 &&
      typeof r.readerId === 'string' && /^[0-9a-f-]{36}$/i.test(r.readerId) &&
      Number.isInteger(r.page) && r.page > 0 && r.page <= 100000 &&
      Number.isInteger(r.message) && r.message >= 0 && r.message < 100 &&
      Number.isInteger(r.image) && r.image >= 0 && r.image < 16 && ['preview', 'original'].includes(r.size);
  } });
}
module.exports = { registerConversationImages };
