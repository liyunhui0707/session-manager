'use strict';
module.exports = async ({ base, check }) => {
  const { app } = require('electron');
  const fs = require('node:fs/promises'), path = require('node:path');
  const { zstdCompressSync } = require('node:zlib');
  const { createConversationReader } = require(app.getAppPath() + '/lib/codex-page-reader-v2');
  const root = path.join(base, 'page-cache'); await fs.mkdir(root);
  const rows = Array.from({ length: 620 }, (_, n) => JSON.stringify({ type: 'event_msg',
    payload: { type: 'user_message', message: `Synthetic cache prompt ${n}` } }) + '\n').join('');
  for (const compressed of [false, true]) {
    const filePath = path.join(root, 'rollout-cache.jsonl' + (compressed ? '.zst' : ''));
    const data = compressed ? zstdCompressSync(rows) : Buffer.from(rows);
    await fs.writeFile(filePath, data);
    const reader = createConversationReader(), kind = compressed ? 'compressed' : 'plain';
    try {
      const source = { filePath, canonicalRoot: root, name: 'Synthetic cache' };
      const latest = await reader.open(source), id = latest.page.readerId;
      const previous = await reader.move(id, 'previous');
      await reader.move(id, 'previous');
      const revisit = await reader.move(id, 'next');
      const stats = reader.getReadStats();
      check(`packaged ${kind} neighboring pages and revisits avoid rescanning`, stats.scans === 1 && stats.validations === 3 &&
        previous.conversation.messages[0].text === 'Synthetic cache prompt 500' &&
        JSON.stringify(previous.conversation) === JSON.stringify(revisit.conversation));
      check(`packaged ${kind} cache never writes source or exposes private pages`,
        data.equals(await fs.readFile(filePath)) && !('window' in previous));
      await fs.writeFile(filePath, compressed ? zstdCompressSync(rows + '\n') : rows + '\n');
      let changed = false;
      try { await reader.move(id, 'previous'); } catch (error) { changed = error.code === 'SOURCE_CHANGED'; }
      const refreshed = await reader.move(id, 'latest');
      check(`packaged ${kind} changed source rejects cache and refresh recovers`, changed && refreshed.page.latest && refreshed.page.number === 7);
    } finally { await reader.close(); }
  }
};
