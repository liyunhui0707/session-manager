'use strict';
// Real layout/IntersectionObserver regression using only a synthetic image.
module.exports = async ({ base, win, check, e, dialog, image }) => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const file = path.join(base, 'automatic-images/rollout-image-scroll.jsonl');
  const message = `<image name=[Image #1] path="${image}"></image>\n` +
    Array.from({ length: 80 }, (_, i) => `Synthetic reading anchor ${i}.`).join('\n\n');
  fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } }) + '\n');
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = digest();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  win.show(); win.focus();
  await e('sessionManagerApp.chooseCodexFile()');
  await e("window.__imageReader=document.querySelector('.read-shell');window.__imageReader.scrollTop=0");
  const pause = () => new Promise(resolve => setTimeout(resolve, 150));
  async function until(code) {
    for (let n = 0; n < 60; n++) { if (await e(code)) return true; await pause(); }
    return false;
  }
  const loaded = "document.querySelector('.attachment-preview img')?.naturalWidth===800";
  check('scroll fixture loads its image', await until(loaded));
  const originalHeight = await e('window.__imageReader.scrollHeight');
  for (let n = 0; n < 3; n++) {
    const position = await e(`(()=>{const r=window.__imageReader,c=document.querySelector('.attachment-controls');
      r.scrollTop+=c.getBoundingClientRect().bottom-r.getBoundingClientRect().top+80;return r.scrollTop})()`);
    check(`image scroll ${n}: offscreen pixels released`, await until("!document.querySelector('.attachment-preview img')"));
    await pause();
    check(`image scroll ${n}: release preserves document height and reading position`,
      await e(`window.__imageReader.scrollHeight===${originalHeight}&&Math.abs(window.__imageReader.scrollTop-${position})<=1`));
    await e('window.__imageReader.scrollTop=0');
    check(`image scroll ${n}: returning restores pixels`, await until(loaded));
    check(`image scroll ${n}: restoration preserves height and top position`,
      await e(`window.__imageReader.scrollHeight===${originalHeight}&&window.__imageReader.scrollTop===0`));
  }
  await e("document.querySelector('.attachment-close').click()");
  for (let n = 0; n < 2; n++) {
    await e('window.__imageReader.scrollTop=window.__imageReader.scrollHeight'); await pause();
    await e('window.__imageReader.scrollTop=0'); await pause();
  }
  check('explicitly closed image stays closed after repeated scrolling',
    await e("!document.querySelector('.attachment-preview img')&&document.querySelector('.attachment-preview').children.length===0"));
  await e("Array.from(document.querySelectorAll('.attachment-controls button')).find(b=>b.textContent==='加载图片').click()");
  check('explicit load reopens a dismissed image', await until(loaded));
  win.setSize(900, 650); await pause();
  check('image slot remains responsive at narrow window width', await e(`(()=>{
    const slot=document.querySelector('.attachment-image-slot'),img=slot.querySelector('img');
    return img&&Math.abs(slot.getBoundingClientRect().height-img.getBoundingClientRect().height)<1&&
      slot.getBoundingClientRect().right<=document.querySelector('.read-shell').getBoundingClientRect().right;
  })()`));
  check('image scroll regression leaves source unchanged', digest() === before);
  await e('delete window.__imageReader');
};
