'use strict';
// Exercise recovery with invented files only; never inspect the selected user source.
module.exports = async ({ base, win, check, e, dialog }) => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const { nativeTheme } = require('electron');
  const root = path.join(base, 'experience-source'), dir = path.join(root, 'sessions/2026/11/05');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'eeeeeeee-eeee-4eee-8eee-000000000001';
  const file = path.join(dir, `rollout-2026-11-05T00-00-00-${id}.jsonl`);
  const records = [{ type: 'session_meta', payload: { id, source: 'cli' } }];
  for (let i = 0; i < 70; i++) records.push(
    { type: 'event_msg', payload: { type: 'user_message', message: `阅读体验提示 ${i}` } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `阅读体验回复 ${i}` } });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before = hash();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  await e('sessionManagerApp.chooseCodexFolder()');
  const entry = await e('sessionManagerApp.getState().folder.entries[0].entryId');
  await e(`sessionManagerApp.openCodexCatalogEntry(${JSON.stringify(entry)})`);
  check('Chinese part position and roles at latest', await e("/第 2 \\/ 2 部分.*已到最新/.test(document.getElementById('transcriptPageStatus').textContent) && document.querySelector('.user-turn h2').textContent==='你' && document.querySelector('.assistant-turn h2').textContent==='助手'"));
  await e("document.getElementById('folderFilterInput').value='没有此标题';document.getElementById('folderFilterInput').dispatchEvent(new Event('input'))");
  check('empty filter explains recovery without clearing reader', await e("document.getElementById('sessionList').textContent.includes('没有找到匹配的会话') && document.getElementById('readMount').textContent.includes('阅读体验回复 69')"));
  await e("document.getElementById('folderFilterInput').value='';document.getElementById('folderFilterInput').dispatchEvent(new Event('input'))");
  // This scenario tests retry, not removal detection: suppress incidental timer/focus
  // polls while the fixture is temporarily renamed. Foreground reload drains any active poll.
  await e('window.__recoveryTick=codexLive.tick;codexLive.tick=async()=>{};sessionManagerApp.reloadCodexFolderEntry()');
  const body = await e("document.getElementById('readMount').textContent");
  fs.renameSync(file, file + '.held');
  await e('sessionManagerApp.reloadCodexFolderEntry()');
  check('failed read preserves body and offers visible retry', await e(`document.getElementById('readMount').textContent===${JSON.stringify(body)} && !document.getElementById('statusRetry').hidden && document.getElementById('status').textContent.includes('当前内容已保留') && getComputedStyle(document.querySelector('.operation-bar')).display!=='none'`));
  win.setSize(900, 600); nativeTheme.themeSource = 'light';
  await e("readerShell.setPreference('theme','light')");
  await new Promise(r => setTimeout(r, 120));
  check('recovery controls fit minimum window', await e("document.documentElement.dataset.theme==='light' && document.documentElement.scrollWidth<=innerWidth && document.getElementById('statusRetry').getBoundingClientRect().right<=innerWidth"));
  fs.writeFileSync(base + '/experience-error-light.png', (await win.webContents.capturePage()).toPNG());
  nativeTheme.themeSource = 'dark'; await e("readerShell.setPreference('theme','dark')"); await new Promise(r => setTimeout(r, 120));
  fs.writeFileSync(base + '/experience-error-dark.png', (await win.webContents.capturePage()).toPNG());
  fs.renameSync(file + '.held', file);
  await e("document.getElementById('statusRetry').click()");
  for (let i = 0; i < 200 && await e('sessionManagerApp.isBusy()'); i++) await new Promise(r => setTimeout(r, 20));
  check('retry reopens the same conversation and clears error', await e(`!sessionManagerApp.isBusy() && document.getElementById('statusRetry').hidden && document.getElementById('status').dataset.kind==='status' && document.getElementById('readMount').textContent===${JSON.stringify(body)}`));
  await e('codexLive.tick=window.__recoveryTick;delete window.__recoveryTick');
  let release;
  dialog.showOpenDialog = () => new Promise(resolve => { release = resolve; });
  await e('void sessionManagerApp.chooseCodexFile()');
  for (let i = 0; i < 50 && !release; i++) await new Promise(r => setTimeout(r, 20));
  check('opening is announced and duplicate source actions disabled', await e("document.getElementById('status').dataset.kind==='busy' && document.getElementById('readMount').getAttribute('aria-busy')==='true' && document.getElementById('openCodexFolderButton').disabled"));
  release({ canceled: true, filePaths: [] });
  for (let i = 0; i < 100 && await e('sessionManagerApp.isBusy()'); i++) await new Promise(r => setTimeout(r, 20));
  check('cancel restores controls and preserves current conversation', await e(`!document.getElementById('openCodexFolderButton').disabled && document.getElementById('readMount').getAttribute('aria-busy')==='false' && document.getElementById('readMount').textContent===${JSON.stringify(body)}`));
  await e("codexLive.search('不可能存在的合成关键词','current')");
  check('empty search is explicit and submit becomes available again', await e("document.getElementById('codexSearchStatus').textContent.includes('没有找到匹配内容') && document.getElementById('codexSearchStatus').textContent.includes('搜索完成') && !document.getElementById('codexSearchSubmit').disabled"));
  check('reading and recovery leave synthetic source bytes unchanged', hash() === before);
};
