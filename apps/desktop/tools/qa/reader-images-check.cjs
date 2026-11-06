'use strict';
module.exports = async function ({ base, win, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const root = path.join(base, 'automatic-images'); fs.mkdirSync(root);
  const image = path.join(root, 'sketch.png'), file = path.join(root, 'rollout-images.jsonl');
  const png = await e(`(()=>{const c=document.createElement('canvas');c.width=5120;c.height=2820;
    const x=c.getContext('2d');x.fillStyle='#faf9f6';x.fillRect(0,0,5120,2820);x.fillStyle='#e0eae1';x.fillRect(0,0,380,2820);
    x.fillStyle='#35634f';x.font='bold 48px sans-serif';x.fillText('A place to look back',450,170);
    x.fillStyle='#fff';x.fillRect(450,250,1040,400);x.fillStyle='#68716c';x.font='32px sans-serif';x.fillText('Conversations, quietly collected.',500,340);
    return c.toDataURL('image/png').split(',')[1]})()`);
  fs.writeFileSync(image, Buffer.from(png, 'base64'));
  fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message',
    message: `<image name=[Image #1] path="${image}"></image>\n这是一张虚构的界面草图。` } }) + '\n');
  const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const sourceHash = hash(file), imageHash = hash(image);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  win.setSize(1100,820);
  await e("document.documentElement.dataset.theme='light'");
  await e('sessionManagerApp.chooseCodexFile()');
  async function until(expression) {
    for (let n = 0; n < 100; n++) {
      if (await e(expression)) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  }
  check('referenced local image automatically loads a bounded thumbnail', await until("document.querySelector('.attachment-preview img')?.naturalWidth===800"));
  check('associated image displays original dimensions without exposing its path', await e("document.querySelector('.attachment-controls [role=status]').textContent.includes('5120 × 2820') && !document.getElementById('readMount').textContent.includes('automatic-images')"));
  await e("document.querySelector('.attachment-preview img').click()");
  check('clicking the thumbnail opens original pixels in an accessible modal', await until("document.querySelector('.image-lightbox[open] img')?.naturalWidth===5120 && document.querySelector('.image-lightbox').hasAttribute('aria-label')"));
  fs.writeFileSync(base + '/automatic-image-light.png', (await win.webContents.capturePage()).toPNG());
  await e("document.querySelector('.image-lightbox button').click()");
  check('original-size control expands image inside a scrollable viewport', await e("document.querySelector('.image-lightbox').dataset.actual==='true' && document.querySelector('.image-lightbox img').getBoundingClientRect().width===5120 && document.documentElement.scrollWidth<=innerWidth"));
  await e("window.__enlargedImage=document.querySelector('.image-lightbox img')");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  check('Escape releases original pixels, closes the image and returns keyboard focus', await until("!document.querySelector('.image-lightbox') && !window.__enlargedImage.hasAttribute('src') && document.activeElement.textContent==='查看大图'"));
  fs.renameSync(image, path.join(root, 'removed.png'));
  await e('sessionManagerApp.reloadCodexFile()');
  check('a removed original has a useful missing-image state', await until("document.querySelector('.attachment-controls [role=status]').textContent.includes('原图已不存在') && !document.querySelector('.attachment-preview img')"));
  fs.renameSync(path.join(root, 'removed.png'), image);
  await e('sessionManagerApp.reloadCodexFile()');
  await until("document.querySelector('.attachment-preview img')?.naturalWidth===800");
  await e("document.documentElement.dataset.theme='dark';document.querySelector('.attachment-preview img').click()");
  await until("!!document.querySelector('.image-lightbox[open]')");
  fs.writeFileSync(base + '/automatic-image-dark.png', (await win.webContents.capturePage()).toPNG());
  const reloaded = await e('sessionManagerApp.reloadCodexFile()');
  check('reloading the conversation disposes the original-image modal', reloaded && await e("!document.querySelector('.image-lightbox')"));
  check('automatic image association preserves transcript and image bytes', hash(file) === sourceHash && hash(image) === imageHash);
};
