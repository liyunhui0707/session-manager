'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readCodexPage, PAGE_MESSAGES, MAX_RECORD_BYTES } = require('../../tools/legacy-reader/codex-page-read');
const line = (text, role = 'user') => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role, content: [{ type: 'input_text', text }],
} }) + '\n';
async function fixture(t, content) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asm-page-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'rollout-synthetic.jsonl');
  await fs.writeFile(filePath, content);
  return { filePath, canonicalRoot: root };
}
test('bounded pages preserve order, duplicate prompts and UTF-8 across chunk boundaries', async t => {
  const texts = Array.from({ length: 237 }, (_, i) => i % 3 ? `消息 ${i} ` + '文'.repeat(701) : 'same question');
  const source = await fixture(t, texts.map(text => line(text)).join(''));
  const before = await fs.stat(source.filePath);
  let offset = 0, snapshot; const actual = [];
  do {
    const page = await readCodexPage({ ...source, offset, snapshot });
    assert.ok(page.conversation.messages.length <= PAGE_MESSAGES);
    assert.ok(page.nextOffset > offset);
    actual.push(...page.conversation.messages.map(m => m.text));
    offset = page.nextOffset; snapshot = page.snapshot;
  } while (offset < before.size);
  assert.deepEqual(actual, texts);
  assert.equal((await fs.stat(source.filePath)).mtimeMs, before.mtimeMs);
});
test('first page of a source over 50 MiB reads only a bounded prefix', async t => {
  const source = await fixture(t, line('first'));
  const handle = await fs.open(source.filePath, 'a');
  const block = line('synthetic '.repeat(600));
  for (let i = 0; i < 9000; i++) await handle.write(block);
  await handle.close();
  const page = await readCodexPage(source);
  assert.ok(page.snapshot.size > 50 * 1024 * 1024);
  assert.equal(page.conversation.messages[0].text, 'first');
  assert.ok(page.bytesRead < 2 * 1024 * 1024);
  assert.ok(page.nextOffset < page.snapshot.size);
});
test('completed malformed records and unfinished final records remain distinct', async t => {
  const source = await fixture(t, 'bad\n' + line('okay') + '{unfinished');
  const page = await readCodexPage(source);
  assert.equal(page.conversation.diagnostics.malformedRecords, 1);
  assert.equal(page.conversation.diagnostics.unparsedFinalRecord, 1);
});
test('changed, replaced, symlink and non-regular sources never yield a mixed page', async t => {
  const source = await fixture(t, line('before'));
  const first = await readCodexPage(source);
  await fs.appendFile(source.filePath, line('after'));
  await assert.rejects(readCodexPage({ ...source, snapshot: first.snapshot }), { code: 'SOURCE_CHANGED' });
  const link = path.join(source.canonicalRoot, 'rollout-link.jsonl');
  await fs.symlink(source.filePath, link);
  await assert.rejects(readCodexPage({ ...source, filePath: link }));
  await assert.rejects(readCodexPage({ ...source, filePath: source.canonicalRoot }));
});
test('oversized records are rejected explicitly instead of silently dropping text', async t => {
  const source = await fixture(t, 'x'.repeat(MAX_RECORD_BYTES + 1));
  await assert.rejects(readCodexPage(source), { code: 'RECORD_TOO_LARGE' });
});

test('an oversized message is rejected explicitly while metadata-only spans make progress', async t => {
  const source = await fixture(t, line('x'.repeat(512 * 1024 + 1)));
  await assert.rejects(readCodexPage(source), { code: 'MESSAGE_TOO_LARGE' });
  await fs.writeFile(source.filePath, (JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(4000) } }) + '\n').repeat(1300) + line('after tools'));
  const first = await readCodexPage(source);
  assert.equal(first.conversation.messages.length, 0);
  assert.ok(first.nextOffset > 0 && first.nextOffset < first.snapshot.size);
  const second = await readCodexPage({ ...source, offset: first.nextOffset, snapshot: first.snapshot });
  assert.equal(second.conversation.messages[0].text, 'after tools');
});

test('directory replacement after descriptor opening is rejected before publishing a page', async t => {
  const source = await fixture(t, line('original'));
  const originalOpen = fs.open;
  const moved = source.canonicalRoot + '-moved';
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === source.filePath) {
      await fs.rename(source.canonicalRoot, moved);
      await fs.mkdir(source.canonicalRoot);
      await fs.writeFile(source.filePath, line('replacement must not be displayed'));
    }
    return handle;
  });
  await assert.rejects(readCodexPage(source), { code: 'SOURCE_CHANGED' });
});

test('a source mutation during reading discards the completed page', async t => {
  const source = await fixture(t, line('original'));
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === source.filePath) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        await fs.appendFile(source.filePath, '\n{}');
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(readCodexPage(source), { code: 'SOURCE_CHANGED' });
});
