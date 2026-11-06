'use strict';
// Invented image and question data only. The OS file chooser is not automated:
// a browser File simulates the result of the user's explicit image selection.
module.exports = async function ({ base, win, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const root = path.join(base, 'presentation-source'); fs.mkdirSync(root);
  const file = path.join(root, 'rollout-synthetic.jsonl');
  const question = '<send_user_message_question_reply>' + JSON.stringify([
    { question: '阅读器应该采用哪一种视觉方向？', answer: '简洁精致，类似 macOS 原生阅读器。', questionItemId: 'synthetic-private-routing' },
    { question: '是否保留浅色与深色主题？', answer: '都保留，跟随系统外观。' },
  ]) + '</send_user_message_question_reply>';
  const text = '<image name=[Image #1] path="/tmp/never-read-synthetic.png">\n</image>\n请参考这张界面草图。';
  const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  fs.writeFileSync(file, record('event_msg', { type: 'user_message', message: text }) +
    record('event_msg', { type: 'task_complete', last_agent_message: '图片将以附件卡片呈现，原始聊天文件保持不变。' }) +
    record('event_msg', { type: 'user_message', message: question }) +
    record('event_msg', { type: 'task_complete', last_agent_message: '收到。保留安静的阅读布局，并提供浅色与深色主题。' }));
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  await e('sessionManagerApp.chooseCodexFile()');
  check('question replies render readable question and answer cards', await e("document.querySelectorAll('.question-reply').length===2 && document.querySelector('.question-answer').textContent.includes('简洁精致') && !document.getElementById('readMount').textContent.includes('questionItemId')"));
  check('untrusted outside image references produce path-free cards without image loads', await e("document.querySelectorAll('.attachment-card').length===1 && document.querySelectorAll('.attachment-card img').length===0 && !document.getElementById('readMount').textContent.includes('never-read-synthetic')"));
  check('image CSP permits only object URLs', await e("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content.includes('img-src blob:;')"));
  await e("codexLive.search('macOS 原生阅读器','current')");
  check('whole conversation finds readable question answers', await e("document.querySelectorAll('.codex-search-hit').length===1 && document.querySelector('.codex-search-hit').textContent.includes('macOS 原生阅读器')"));
  await e("codexLive.search('synthetic-private-routing','current')");
  check('transport IDs do not appear in search results', await e("document.querySelectorAll('.codex-search-hit').length===0"));
  win.setSize(1100, 820);
  await e("document.querySelectorAll('dialog[open]').forEach(x=>x.close());document.documentElement.dataset.theme='light'; document.querySelector('.read-shell').scrollTop=0");
  const selectImage = `async function selectSyntheticImage() {
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=280;
    const c=canvas.getContext('2d');c.fillStyle='#faf9f6';c.fillRect(0,0,640,280);
    c.fillStyle='#e0eae1';c.fillRect(0,0,155,280);c.fillStyle='#35634f';c.fillRect(20,25,115,12);
    c.fillStyle='#fff';c.fillRect(185,70,425,110);c.fillStyle='#68716c';c.font='18px sans-serif';c.fillText('A quiet place to read',205,115);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
    const dt=new DataTransfer();dt.items.add(new File([blob],'synthetic-layout.png',{type:'image/png'}));
    const input=document.querySelector('.attachment-card input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change'));
    for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,25));const img=document.querySelector('.attachment-preview img');if(img?.complete&&img.naturalWidth===640)return true;}return false;
  }`;
  await e(selectImage + ";window.__revokedImages=[];window.__originalRevoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=u=>{window.__revokedImages.push(u);window.__originalRevoke(u)};true");
  check('explicitly selected synthetic PNG decodes in sandboxed packaged reader', await e('selectSyntheticImage()'));
  check('preview has readable dimensions and stays inside reading column', await e("document.querySelector('.attachment-controls [role=status]').textContent.includes('640 × 280') && document.querySelector('.attachment-preview img').getBoundingClientRect().right<=document.querySelector('.attachment-card').getBoundingClientRect().right"));
  fs.writeFileSync(base + '/presentation-image-light.png', (await win.webContents.capturePage()).toPNG());
  await e("document.querySelector('.attachment-close').click()");
  check('closing preview releases object URL and removes pixels', await e("window.__revokedImages.length===1 && !document.querySelector('.attachment-preview img')"));
  await e('selectSyntheticImage()');
  await e('sessionManagerApp.reloadCodexFile()');
  check('reloading conversation releases preview and does not persist image selection', await e("window.__revokedImages.length===2 && !document.querySelector('.attachment-preview img')"));
  await e("document.querySelector('.question-reply').scrollIntoView({block:'center'})");
  fs.writeFileSync(base + '/presentation-questions-light.png', (await win.webContents.capturePage()).toPNG());
  win.setSize(900,600);
  await e("document.documentElement.dataset.theme='dark';document.querySelector('.question-reply').scrollIntoView({block:'center'})");
  check('question cards fit narrow dark reader', await e("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.question-reply').getBoundingClientRect().width>0"));
  fs.writeFileSync(base + '/presentation-questions-dark.png', (await win.webContents.capturePage()).toPNG());
  check('presentation and preview preserve synthetic transcript bytes', hash() === before);
};
