'use strict';
module.exports = async function ({ base, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const { zstdCompressSync } = require('node:zlib');
  const root = path.join(base, 'origin-source'), active = path.join(root, 'sessions/2026/11/04');
  fs.mkdirSync(active, { recursive: true });
  const ids = Array.from({ length: 11 }, (_, n) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`);
  const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  const payloads = [{ source: { subagent: { other: 'guardian' } } }, { source: { internal: 'guardian' } },
    { source: 'cli' }, { source: 'cli' },
    { source: { subagent: { thread_spawn: { parent_thread_id: ids[2], depth: 1 } } } },
    { source: { subagent: 'compact' } }, { thread_source: 'subagent' },
    { source: { internal: 'memory_consolidation' } }, { source: 'cli', parent_thread_id: ids[2] },
    { source: 'exec', thread_source: 'user' }, { source: 'mcp', thread_source: 'user' }];
  const files = ids.map((id, n) => {
    const compressed = n === 1 || n === 5 || n === 10;
    const file = path.join(active, `rollout-2026-11-04T00-00-00-${id}.jsonl${compressed ? '.zst' : ''}`);
    const content = record('session_meta', { id, ...payloads[n] }) +
      record('event_msg', { type: 'user_message', message: 'Synthetic origin searchable phrase' });
    fs.writeFileSync(file, compressed ? zstdCompressSync(content) : content); return file;
  });
  const index = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(index, record('unused', {}) + JSON.stringify({ id: ids[3], thread_name: 'Guardian review' }) + '\n');
  files.push(index);
  const digest = () => files.map(p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')).join(':');
  const before = digest();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  const opened = await e('sessionManagerApp.chooseCodexFolder()');
  const observed = await e("({count:sessionManagerApp.getState().folder.entries.length,diagnostics:document.getElementById('folderDiagnostics').textContent,subtitle:document.getElementById('sourceSubtitle').textContent,status:document.getElementById('status').textContent})");
  fs.writeFileSync(path.join(base, 'origin-observation.json'), JSON.stringify({ opened, ...observed }, null, 2));
  check('raw and compressed reviews, subagents and non-interactive sessions excluded before counts', await e("sessionManagerApp.getState().folder.entries.length===2 && document.getElementById('folderDiagnostics').textContent.includes('隐藏 2 个后台审核') && document.getElementById('folderDiagnostics').textContent.includes('隐藏 5 个子代理或后台会话') && document.getElementById('folderDiagnostics').textContent.includes('隐藏 2 个非交互记录') && document.getElementById('sourceSubtitle').textContent.includes('2 个未归档对话')"));
  check('normal unnamed session retained', await e(`sessionManagerApp.getState().folder.entries.some(x=>x.sessionId===${JSON.stringify(ids[2])})`));
  check('normal chat named Guardian review retained', await e("document.getElementById('sessionList').textContent.includes('Guardian review')"));
  await e("codexLive.search('origin searchable phrase','all')");
  check('all-session search excludes review and subagent bodies', await e("document.querySelectorAll('.codex-search-hit').length===2"));
  await e('codexLive.tick()');
  check('automatic sync preserves origin filtering', await e('sessionManagerApp.getState().folder.entries.length===2'));
  check('origin classification and search leave synthetic sources unchanged', digest() === before);
};
