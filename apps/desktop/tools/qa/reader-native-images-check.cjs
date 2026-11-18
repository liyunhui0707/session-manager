'use strict';
// Only the invented canvas PNG from reader-images-check; no user attachments.
module.exports = async ({ base, win, check, e, dialog, image }) => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const file = path.join(base, 'automatic-images/rollout-native-images.jsonl');
  const text = '[Image #1] 这是合成的原生图片附件。';
  const records = [
    { type: 'event_msg', payload: { type: 'user_message', message: text, images: [], local_images: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text }, { type: 'input_image', image_url: 'data:image/png;base64,' + fs.readFileSync(image).toString('base64') },
    ] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '原生附件与正文应完整保留。' } },
  ];
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = digest();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  win.setSize(1100, 820);
  await e("readerShell.setPreference('theme','light');document.documentElement.dataset.find='closed'");
  await e('sessionManagerApp.chooseCodexFile()');
  await e("document.querySelector('.attachment-card').scrollIntoView({block:'center'})");
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await e(expression)) return true; await new Promise(r => setTimeout(r, 25)); }
    return false;
  }
  check('native image mirrors render one prompt and one attachment card', await e("document.querySelectorAll('.read-section.user-turn').length===1 && document.querySelectorAll('.attachment-card').length===1"));
  check('native encoded PNG lazily decodes to bounded thumbnail', await until("document.querySelector('.attachment-preview img')?.naturalWidth===800"));
  check('native encoded pixels stay out of visible text', await e("!document.getElementById('readMount').textContent.includes('base64') && document.getElementById('readMount').textContent.includes('合成的原生图片')"));
  fs.writeFileSync(base + '/native-image-light.png', (await win.webContents.capturePage()).toPNG());
  await e("document.querySelector('.attachment-preview img').click()");
  check('native attachment original opens at its real resolution', await until("document.querySelector('.image-lightbox img')?.naturalWidth===5120"));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until("!document.querySelector('.image-lightbox')");
  await e("document.querySelector('.attachment-close').click();document.querySelector('.read-shell').scrollTop=0");
  await new Promise(r => setTimeout(r, 100));
  await e("document.querySelector('.read-shell').scrollTop=100000");
  await new Promise(r => setTimeout(r, 150));
  check('closed native preview stays closed after scrolling', await e("!document.querySelector('.attachment-preview img')"));
  await e("document.querySelector('.attachment-controls button').click()");
  check('native preview reopens through explicit load control', await until("document.querySelector('.attachment-preview img')?.naturalWidth===800"));
  await e("readerShell.setPreference('theme','dark')");
  await new Promise(r => setTimeout(r, 150));
  check('native attachment preview supports the dark reader palette', await e("getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()==='#202522'"));
  fs.writeFileSync(base + '/native-image-dark.png', (await win.webContents.capturePage()).toPNG());
  check('native preview remains within the reader column', await e("document.querySelector('.attachment-preview img').getBoundingClientRect().right<=document.querySelector('.attachment-card').getBoundingClientRect().right"));
  check('native image preview preserves transcript bytes', before === digest());
  await e("readerShell.setPreference('theme','light')");
};
