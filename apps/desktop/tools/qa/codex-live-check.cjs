'use strict';
// Mutations below simulate the CLI, only in this newly created synthetic source.
module.exports = async function ({ base, win, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const navigate = require('./page-navigation.cjs');
  const root = path.join(base, 'live-source'), active = path.join(root, 'sessions', '2026', '11', '03');
  const archive = path.join(root, 'archived_sessions');
  fs.mkdirSync(active, { recursive: true }); fs.mkdirSync(archive);
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', second = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
  const name = `rollout-2026-11-03T00-00-00-${id}.jsonl`, file = path.join(active, name);
  const ev = (type, extra = {}) => JSON.stringify({ type: 'event_msg', payload: { type, ...extra } }) + '\n';
  const msg = (text, phase) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] } }) + '\n';
  const turn = n => ev('user_message', { message: `Prompt ${n} — 中文 **Markdown**` }) + msg('HIDDEN_WORKING', 'commentary') + msg(`Final ${n}`, 'final_answer') + ev('task_complete', { last_agent_message: `Final ${n}` });
  fs.writeFileSync(file, Array.from({ length: 115 }, (_, n) => turn(n)).join(''));
  fs.writeFileSync(path.join(archive, `rollout-2026-11-03T00-00-00-${second}.jsonl`), turn(500));
  const index = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(index, JSON.stringify({ id, thread_name: 'Synthetic conversation' }) + '\n');
  const digest = () => {
    const rows = [];
    function walk(p) { for (const n of fs.readdirSync(p).sort()) {
      const f = path.join(p,n), s = fs.statSync(f);
      if (s.isDirectory()) walk(f); else rows.push([path.relative(root,f),s.mode,s.size,s.mtimeMs,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]);
    } }
    walk(root); return JSON.stringify(rows);
  };
  let expected = digest();
  const unchanged = () => { if (digest() !== expected) throw Error('Application changed synthetic source'); };
  const mutate = action => { unchanged(); action(); expected = digest(); };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  await e('sessionManagerApp.chooseCodexFolder()');
  check('archived sessions excluded from public catalog', await e('sessionManagerApp.getState().folder.entries.length===1'));
  const entryId = await e('sessionManagerApp.getState().folder.entries[0].entryId');
  await e(`sessionManagerApp.openCodexCatalogEntry(${JSON.stringify(entryId)})`);
  await e('codexLive.tick()');
  check('only prompts and final replies shown at latest', await e("document.getElementById('readMount').textContent.includes('Final 114') && !document.getElementById('readMount').textContent.includes('HIDDEN_WORKING') && document.querySelectorAll('.read-section').length===30"));
  mutate(() => fs.appendFileSync(index, JSON.stringify({ id, thread_name: 'Renamed automatically' }) + '\n'));
  await e('codexLive.tick()');
  check('rename updates sidebar and open reader automatically', await e("document.getElementById('readTitle').textContent==='Renamed automatically' && document.getElementById('sessionList').textContent.includes('Renamed automatically')"));
  await navigate(e, 'previous');
  await e("document.querySelector('.read-shell').scrollTop=140");
  const before = await e("({ text: document.getElementById('readMount').textContent, top: document.querySelector('.read-shell').scrollTop })");
  mutate(() => fs.appendFileSync(file, turn(115)));
  await e('codexLive.tick()');
  check('new messages preserve historical content and scroll', await e(`document.getElementById('readMount').textContent===${JSON.stringify(before.text)} && document.querySelector('.read-shell').scrollTop===${before.top} && !document.getElementById('codexNewMessages').hidden`));
  await e('codexLive.latest()');
  check('new-message action returns to latest bottom', await e("document.getElementById('readMount').textContent.includes('Final 115') && sessionManagerApp.isFollowingLatest()"));
  mutate(() => fs.appendFileSync(file, turn(116)));
  await e('codexLive.tick()');
  check('following latest automatically loads appended final reply', await e("document.getElementById('readMount').textContent.includes('Final 116') && sessionManagerApp.isFollowingLatest()"));
  await e("codexLive.search('Prompt 2 —', 'all')");
  check('full-text search finds an earlier part', await e("document.querySelectorAll('.codex-search-hit').length===1 && document.getElementById('codexSearchStatus').textContent.includes('搜索完成')"));
  await e("document.querySelector('.codex-search-hit').click()");
  for (let i=0;i<200;i++) { if(await e("document.getElementById('readMount').textContent.includes('Prompt 2 —')")) break; await new Promise(r=>setTimeout(r,20)); }
  check('search result opens exact earlier part and highlights match', await e("document.getElementById('readMount').textContent.includes('Prompt 2 —') && document.querySelectorAll('mark').length>0"));
  await e("codexLive.search('HIDDEN_WORKING', 'current')");
  check('hidden progress is not searchable conversation text', await e("document.querySelectorAll('.codex-search-hit').length===0 && document.getElementById('codexSearchStatus').textContent.includes('搜索完成')"));
  mutate(() => fs.renameSync(file, path.join(archive,name)));
  await e('codexLive.tick()');
  check('archiving removes list entry and clears its displayed body', await e("sessionManagerApp.getState().folder.entries.length===0 && document.getElementById('readMount').textContent===''"));
  mutate(() => fs.renameSync(path.join(archive,name), file));
  await e('codexLive.tick()');
  check('unarchiving restores the named active entry', await e("sessionManagerApp.getState().folder.entries.length===1 && document.getElementById('sessionList').textContent.includes('Renamed automatically')"));
  unchanged(); check('app never writes source during simulated CLI updates', true);
  check('live search layout fits minimum width', await e('document.documentElement.scrollWidth<=innerWidth'));
  fs.writeFileSync(base+'/live-reader.png',(await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(base+'/live-readonly.json',JSON.stringify({ unchangedBetweenExternalMutations:true, manifest:JSON.parse(expected) },null,2));
};
