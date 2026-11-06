'use strict';
module.exports = async function ({ base, win, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path');
  async function capture(name) {
    win.show(); win.focus();
    for (let n = 0; n < 100; n++) {
      if (await e("document.visibilityState==='visible'")) break;
      await new Promise(r=>setTimeout(r,20));
    }
    if (!await e("document.visibilityState==='visible'")) throw Error('Comfort screenshot window is hidden');
    await e("new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('No visible paint')),2000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(t);resolve(true)}))})");
    fs.writeFileSync(base+'/'+name,(await win.webContents.capturePage()).toPNG());
  }
  await e("document.querySelectorAll('dialog[open]').forEach(d=>d.close());readerShell.setPreference('theme','light')");
  const root = path.join(base, 'comfort-source'), dir = path.join(root, 'sessions/2026/11/05');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'eeeeeeee-eeee-4eee-8eee-000000000001', emptyId = 'eeeeeeee-eeee-4eee-8eee-000000000002';
  const line = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  const name = id => path.join(dir, `rollout-2026-11-05T00-00-00-${id}.jsonl`);
  const cwd = '/synthetic/worktrees/a-long-project-directory-for-reading';
  fs.writeFileSync(name(id), line('session_meta', { id, source: 'cli', cwd }) + Array.from({ length: 160 }, (_, n) =>
    line('event_msg', { type: 'user_message', message: 'Prompt ' + n + '\n\n' + 'Comfortable reading. 中文 '.repeat(30) }) +
    line('event_msg', { type: 'task_complete', last_agent_message: 'Answer ' + n + '\n\n' + 'Larger body text. '.repeat(30) })).join(''));
  fs.writeFileSync(name(emptyId), line('session_meta', { id: emptyId, source: 'vscode' }) + line('event_msg', { type: 'thread_settings_applied' }));
  let dialogs = 0;
  dialog.showOpenDialog = async () => { dialogs++; return { canceled: false, filePaths: [root] }; };
  await e('sessionManagerApp.chooseCodexFolder()');
  check('confirmed empty initialization is absent from the sidebar', await e('sessionManagerApp.getState().folder.entries.length===1'));
  await e('sessionManagerApp.initialize()');
  check('startup restores saved custom Codex source without a chooser', dialogs === 1 && await e('sessionManagerApp.getState().sourceMode==="folder" && sessionManagerApp.getState().folder.entries.length===1'));
  await e('sessionManagerApp.openCodexCatalogEntry(sessionManagerApp.getState().folder.entries[0].entryId)');
  const bottom = "Math.abs(document.querySelector('.read-shell').scrollHeight-document.querySelector('.read-shell').clientHeight-document.querySelector('.read-shell').scrollTop)<2";
  check('opening a conversation still lands at the latest bottom', await e(bottom));
  check('header displays metadata cwd and repeated source/footer labels are hidden', await e(`document.getElementById('readerMeta').textContent===${JSON.stringify(cwd)} && document.getElementById('currentSourceChip').hidden && !document.getElementById('readerPosition').textContent`));
  async function move(id) {
    await e(`document.getElementById(${JSON.stringify(id)}).click()`);
    for (let i=0;i<400;i++) { if (await e('!sessionManagerApp.isBusy()')) return; await new Promise(r=>setTimeout(r,20)); }
    throw Error('Navigation did not complete');
  }
  await move('transcriptPrevious'); check('earlier page lands at its bottom', await e(bottom));
  await move('transcriptNext'); check('newer page lands at its top', await e("document.querySelector('.read-shell').scrollTop===0"));
  await move('transcriptFirst'); check('first button opens first part at top', await e("document.getElementById('transcriptPageStatus').textContent.startsWith('第 1 /') && document.querySelector('.read-shell').scrollTop===0 && document.getElementById('readMount').textContent.includes('Prompt 0')"));
  await move('transcriptLatest'); check('latest button returns to last bottom', await e(bottom));
  await e("readerShell.setPreference('font','xxxxlarge');readerShell.setPreference('width','wide')");
  win.setSize(900,600);
  await new Promise(r=>setTimeout(r,150));
  check('26px body at minimum window size keeps page and pager within viewport', await e("getComputedStyle(document.getElementById('readMount')).fontSize==='26px' && document.documentElement.scrollWidth<=innerWidth && document.getElementById('transcriptLatest').getBoundingClientRect().right<=innerWidth"));
  await move('transcriptFirst');
  await new Promise(r=>setTimeout(r,150));
  await capture('comfort-26px.png');
  await e("document.getElementById('settingsButton').click()");
  check('all seven font sizes fit in the settings modal', await e("Array.from(document.querySelectorAll('[data-preference=font]')).length===7 && Array.from(document.querySelectorAll('[data-preference=font]')).every(b=>b.getBoundingClientRect().right<=innerWidth)"));
  await new Promise(r=>setTimeout(r,120));
  await capture('comfort-settings.png');
  await e("document.getElementById('settingsDialog').close()");
  await e("document.getElementById('fontDecrease').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'-',metaKey:true,bubbles:true}))");
  check('font buttons and shortcuts adjust body only', await e("getComputedStyle(document.getElementById('readMount')).fontSize==='22px' && getComputedStyle(document.querySelector('.session-row-title')).fontSize==='12px'"));
  await e("document.dispatchEvent(new KeyboardEvent('keydown',{key:'0',metaKey:true,bubbles:true}));readerShell.setPreference('width','comfortable')");
  check('reset restores standard 16px font', await e("getComputedStyle(document.getElementById('readMount')).fontSize==='16px'"));
  fs.appendFileSync(name(emptyId), line('event_msg', { type: 'user_message', message: 'A new prompt without final answer' }));
  await e('sessionManagerApp.rescanCodexFolder()');
  check('a formerly empty session reappears when a pending prompt arrives', await e('sessionManagerApp.getState().folder.entries.length===2'));
};
