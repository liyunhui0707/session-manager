'use strict';
// Exercise first exposure, not only a preview which has already acquired a size.
// Wheel events use precise small deltas; rAF measures visible text as well as scrollTop.
module.exports = async ({ base, win, check, e, dialog, image }) => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const file = path.join(base, 'automatic-images/rollout-image-entry.jsonl');
  const paragraph = Array.from({ length: 65 }, (_, i) => `Synthetic reading line ${i}.`).join('\n\n');
  const text = value => ({ type: 'response_item', payload: { type: 'message', role: 'assistant',
    phase: 'final_answer', content: [{ type: 'output_text', text: value }] } });
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const direction of ['up', 'down', 'missing']) {
    const source = direction === 'missing' ? path.join(base, 'automatic-images/missing.png') : image;
    fs.writeFileSync(file, [text(paragraph), { type: 'event_msg', payload: { type: 'user_message',
      message: `<image name=[Image #1] path="${source}"></image>` } }, text(paragraph)]
      .map(record => JSON.stringify(record)).join('\n') + '\n');
    const before = digest();
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    win.setSize(1100, 820); win.show(); win.focus();
    await e('sessionManagerApp.chooseCodexFile()'); await pause(150);
    const up = direction !== 'down';
    const point = await e(`(()=>{
      const r=document.querySelector('.read-shell'),c=document.querySelector('.attachment-controls');
      r.scrollTop+=${up ? 'c.getBoundingClientRect().bottom-r.getBoundingClientRect().top+12' : 'c.getBoundingClientRect().top-r.getBoundingClientRect().bottom-12'};
      const b=r.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};
    })()`);
    await pause(100);
    check(`first image ${direction}: image has not loaded before entry`, await e("!document.querySelector('.attachment-preview img')"));
    await e(`(()=>{
      const r=document.querySelector('.read-shell'),anchor=document.querySelectorAll('.read-section')[${up ? 2 : 0}];
      window.__entry={height:r.scrollHeight,maxHeightChange:0,maxAnchorShift:0,top:r.scrollTop};
      let last=anchor.getBoundingClientRect().top+r.scrollTop;
      function sample(){const now=anchor.getBoundingClientRect().top+r.scrollTop;
        __entry.maxAnchorShift=Math.max(__entry.maxAnchorShift,Math.abs(now-last));last=now;
        __entry.maxHeightChange=Math.max(__entry.maxHeightChange,Math.abs(r.scrollHeight-__entry.height));
        __entry.frame=requestAnimationFrame(sample);}
      sample();
    })()`);
    for (let i = 0; i < 40; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: up ? 2 : -2,
        hasPreciseScrollingDeltas: true, canScroll: true });
      await pause(32);
    }
    await pause(350);
    const observed = await e(`(()=>{cancelAnimationFrame(__entry.frame);const r=document.querySelector('.read-shell');
      return {...__entry,scroll:r.scrollTop,note:document.querySelector('.attachment-controls [role=status]').textContent,
        loaded:!!document.querySelector('.attachment-preview img')?.naturalWidth};})()`);
    check(`first image ${direction}: precise wheel input moves the reader`, Math.abs(observed.scroll - observed.top) > 20);
    check(`first image ${direction}: lazy read reaches its expected result`, direction === 'missing'
      ? observed.note.includes('原图已不存在') : observed.loaded);
    check(`first image ${direction}: loading does not move text or change page height`,
      observed.maxHeightChange <= 1 && observed.maxAnchorShift <= 1);
    check(`first image ${direction}: source remains unchanged`, before === digest());
    fs.writeFileSync(path.join(base, `image-entry-${direction}.json`), JSON.stringify(observed, null, 2));
    await e('delete window.__entry');
  }
};
