'use strict';
// Separate invented source. No access to user stores or existing CLI sessions.
module.exports = async function ({ base, win, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const { zstdCompressSync } = require('node:zlib');
  const root = path.join(base, 'recovery-source'), active = path.join(root, 'sessions/2026/11/04');
  fs.mkdirSync(active, { recursive: true });
  const ids = [1, 2, 3].map(n => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`);
  const rec = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  const turn = n => rec('event_msg', { type: 'user_message', message: `Recovery prompt ${n}` }) +
    rec('event_msg', { type: 'task_complete', last_agent_message: `Recovery final ${n}` });
  const giant = rec('response_item', { type: 'function_call_output', output: 'x'.repeat(9 * 1024 ** 2) });
  const imagePrompt = rec('event_msg', { type: 'user_message', message: 'Recovery prompt 0',
    images: [{ url: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 ** 2) }] });
  const text = imagePrompt + rec('event_msg', { type: 'task_complete', last_agent_message: 'Recovery final 0' }) +
    giant + '{broken\n' + turn(1);
  for (let n = 0; n < 3; n++) {
    const content = rec('session_meta', { id: ids[n], source: n === 2 ? { subagent: { other: 'guardian' } } : 'cli' }) + (n === 2 ? turn(2) : text);
    fs.writeFileSync(path.join(active, `rollout-2026-11-04T00-00-00-${ids[n]}.jsonl${n === 1 ? '.zst' : ''}`), n === 1 ? zstdCompressSync(content) : content);
  }
  const index = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(index, ids.map((id,n) => JSON.stringify({ id, thread_name: n === 2 ? 'Guardian review' : `Recovery ${n}` })).join('\n') + '\n');
  const files = [...fs.readdirSync(active).map(n => path.join(active,n)), index];
  const digest = () => JSON.stringify(files.map(p => { const s = fs.statSync(p); return [p,s.mode,s.size,s.mtimeMs,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]; }));
  let before = digest();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  await e('sessionManagerApp.chooseCodexFolder()');
  check('structured review excluded before bodies load', await e("sessionManagerApp.getState().folder.entries.length===2 && !document.getElementById('sessionList').textContent.includes('Guardian review')"));
  check('review exclusion is explained', await e("document.getElementById('folderSourceNotice').textContent.includes('隐藏 1 个后台审核')"));
  for (let n = 0; n < 2; n++) {
    const entry = await e(`sessionManagerApp.getState().folder.entries.find(x=>x.sessionId===${JSON.stringify(ids[n])}).entryId`);
    await e(`sessionManagerApp.openCodexCatalogEntry(${JSON.stringify(entry)})`);
    check(`oversized ${n === 1 ? 'zstd' : 'raw'} image and tool records preserve conversation text`, await e("document.getElementById('readMount').textContent.includes('Recovery final 1') && document.getElementById('readMount').textContent.includes('Recovery prompt 0') && document.querySelectorAll('.read-section').length===4"));
    check(`persistent omitted-content warning ${n}`, await e("!document.getElementById('transcriptReadWarning').hidden && document.getElementById('transcriptReadWarning').textContent.includes('0 条记录超出结构处理上限') && document.getElementById('transcriptReadWarning').textContent.includes('1 条格式损坏或未写完的记录') && !document.querySelector('.read-shell').contains(document.getElementById('transcriptReadWarning'))"));
  }
  await e("codexLive.search('Recovery final 1','all')");
  check('search keeps valid hits and reports partial conversations', await e("document.querySelectorAll('.codex-search-hit').length===2 && document.getElementById('codexSearchStatus').textContent.includes('搜索不完整') && document.getElementById('codexSearchStatus').textContent.includes('2 个会话有未读取内容')"));
  check('recovery reading and searching are read-only', digest() === before);
  fs.appendFileSync(index, JSON.stringify({ id: ids[2], thread_name: 'My renamed conversation' }) + '\n');
  before = digest(); await e('codexLive.tick()');
  check('renaming a background review cannot turn it into a user conversation', await e("sessionManagerApp.getState().folder.entries.length===2 && !document.getElementById('sessionList').textContent.includes('My renamed conversation')"));
  check('rename polling is read-only', digest() === before);
  await e("document.querySelector('.source-menu').open=false; document.querySelector('.diagnostics-panel').open=false");
  fs.writeFileSync(base+'/recovery-900.png',(await win.webContents.capturePage()).toPNG());
};
