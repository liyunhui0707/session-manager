'use strict';
module.exports = async function ({ base, win, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const { navigate } = { navigate: require('./page-navigation.cjs') };
  const root = path.join(base, 'large-body-source'); fs.mkdirSync(root);
  const file = path.join(root, 'rollout-large-body.jsonl');
  const rec = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  const answer = '```text\n' + 'Readable 中文 line\n'.repeat(850000) + '```\n\n**FINAL-LARGE-NEEDLE**';
  check('large-body fixture exceeds sixteen MiB of visible text', Buffer.byteLength(answer) > 16 * 1024 ** 2);
  fs.writeFileSync(file, rec('event_msg', { type: 'user_message', message: 'Please explain this long example.' }) +
    rec('event_msg', { type: 'task_complete', last_agent_message: answer }));
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = digest();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  await e('sessionManagerApp.chooseCodexFile()');
  check('large reply opens at its final readable part without an omission warning', await e("document.getElementById('readMount').textContent.includes('FINAL-LARGE-NEEDLE') && document.getElementById('transcriptReadWarning').hidden && document.getElementById('transcriptNext').disabled"));
  check('long-message part label and Markdown final text are visible', await e("document.querySelector('.message-part-label').textContent.includes('长消息') && [...document.querySelectorAll('.assistant-turn strong')].some(n=>n.textContent==='FINAL-LARGE-NEEDLE')"));
  await navigate(e, 'previous');
  check('earlier large reply part keeps its code block context', await e("document.querySelector('.assistant-turn pre code').textContent.includes('Readable 中文 line') && document.querySelector('.assistant-turn .message-full-body').hidden===false"));
  await e("document.querySelector('.assistant-turn .message-disclosure').click()");
  check('folding a long part preserves its visible continuation label', await e("document.querySelector('.assistant-turn .message-full-body').hidden && document.querySelector('.message-part-label').getBoundingClientRect().height>0"));
  await e("document.querySelector('.assistant-turn .message-disclosure').click()");
  check('expanded large part stays inside the narrow reader', await e("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.assistant-turn pre').getBoundingClientRect().right<=innerWidth"));
  await e("codexLive.search('FINAL-LARGE-NEEDLE','current')");
  check('whole conversation search includes the formerly oversized final', await e("document.querySelectorAll('.codex-search-hit').length===1 && document.getElementById('codexSearchStatus').textContent.includes('搜索完成')"));
  await e("document.querySelector('.codex-search-hit').click()");
  let opened = false;
  for (let n = 0; n < 100; n++) {
    opened = await e("!sessionManagerApp.isBusy() && document.getElementById('readMount').textContent.includes('FINAL-LARGE-NEEDLE') && !!document.querySelector('mark')");
    if (opened) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  check('search opens and highlights the correct long-message part', opened);
  check('search highlight is inside the reader viewport', await e("(()=>{const m=document.querySelector('mark.mark--active')?.getBoundingClientRect(),r=document.querySelector('.read-shell').getBoundingClientRect();return !!m && m.bottom>r.top && m.top<r.bottom && m.right>r.left && m.left<r.right})()"));
  check('large-body navigation and search preserve original source bytes', digest() === before);
  await e("document.querySelectorAll('dialog[open]').forEach(x=>x.close())");
  fs.writeFileSync(base + '/large-body-dark.png', (await win.webContents.capturePage()).toPNG());
};
