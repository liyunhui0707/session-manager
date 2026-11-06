'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCodexPagedReader } = require('../../tools/legacy-reader/codex-paged-reader');
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-paged-worker-')));
  const filePath = path.join(root, 'rollout-example.jsonl');
  const lines = Array.from({ length: 215 }, (_, i) => JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: `message ${i}` }],
  } }));
  await fs.writeFile(filePath, lines.join('\n'));
  const reader = createCodexPagedReader();
  t.after(async () => { await reader.cancel(); await fs.rm(root, { recursive: true, force: true }); });
  return { reader, filePath, root };
}
test('worker pages expose only opaque navigation, bound current messages, and reread previous pages', async t => {
  const { reader, filePath, root } = await setup(t);
  const first = await reader.open({ filePath, canonicalRoot: root, name: 'Example' });
  assert.equal(first.conversation.messages.length, 100);
  assert.equal(first.page.hasNext, true);
  assert.equal(first.page.hasPrevious, false);
  assert.ok(!JSON.stringify(first).includes(root));
  const second = await reader.move(first.page.readerId, 'next');
  assert.equal(second.conversation.messages[0].text, 'message 100');
  const third = await reader.move(first.page.readerId, 'next');
  assert.equal(third.conversation.messages.length, 15);
  assert.equal(third.page.hasNext, false);
  const back = await reader.move(first.page.readerId, 'previous');
  assert.deepEqual(back.conversation, second.conversation);
  await assert.rejects(reader.move(filePath, 'next'), { code: 'STALE_READER' });
  await assert.rejects(reader.move(first.page.readerId, '../escape'), { code: 'INVALID_REQUEST' });
});
test('cancelled work terminates the worker and preserves the completed page', async t => {
  const { reader, filePath, root } = await setup(t);
  const first = await reader.open({ filePath, canonicalRoot: root, name: 'Example' });
  const pending = reader.move(first.page.readerId, 'next');
  const rejected = assert.rejects(pending, { code: 'READ_CANCELLED' });
  assert.equal(await reader.cancel(), true);
  await rejected;
  const second = await reader.move(first.page.readerId, 'next');
  assert.equal(second.page.number, 2);
  assert.equal(second.conversation.messages[0].text, 'message 100');
});
test('failed open preserves navigation; successful replacement revokes the old ID', async t => {
  const { reader, filePath, root } = await setup(t);
  const first = await reader.open({ filePath, canonicalRoot: root, name: 'Example' });
  await assert.rejects(reader.open({ filePath: path.join(root, 'rollout-missing.jsonl'), canonicalRoot: root }));
  assert.equal((await reader.move(first.page.readerId, 'next')).page.number, 2);
  const replacement = await reader.open({ filePath, canonicalRoot: root, name: 'Again' });
  assert.notEqual(replacement.page.readerId, first.page.readerId);
  await assert.rejects(reader.move(first.page.readerId, 'next'), { code: 'STALE_READER' });
  await fs.appendFile(filePath, '\n{}');
  await assert.rejects(reader.move(replacement.page.readerId, 'next'), { code: 'SOURCE_CHANGED' });
});

test('background workers do not inherit main-process debugger break or preload arguments', async () => {
  const vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const source = await fs.readFile(path.join(__dirname, '../../tools/legacy-reader/codex-paged-reader.js'), 'utf8');
  let options;
  class Worker extends EventEmitter {
    constructor(_file, config) {
      super(); options = config;
      queueMicrotask(() => {
        this.emit('message', { ok: true, result: { snapshot: { size: 0 }, nextOffset: 0, conversation: { messages: [] } } });
        this.emit('exit', 0);
      });
    }
  }
  const sandbox = { module: { exports: {} }, __dirname: path.join(__dirname, '../../lib'),
    setTimeout, clearTimeout, require: id => id === 'node:worker_threads' ? { Worker } : require(id) };
  vm.runInNewContext(source, sandbox);
  await sandbox.module.exports.createCodexPagedReader().open({ filePath: '/synthetic/rollout-a.jsonl', canonicalRoot: '/synthetic', name: 'Synthetic' });
  assert.equal(JSON.stringify(options.execArgv), '[]');
});
