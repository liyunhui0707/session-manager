'use strict';
// Start at the actual latest-message position. No scrollTop setup or forced load.
module.exports = async ({ base, win, check, e, dialog, image }) => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const file = path.join(base, 'automatic-images/rollout-bottom-up.jsonl');
  const final = text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant',
    phase: 'final_answer', content: [{ type: 'output_text', text }] } });
  fs.writeFileSync(file, [final('Earlier synthetic conversation.'),
    { type: 'event_msg', payload: { type: 'user_message', message: `<image name=[Image #1] path="${image}"></image>` } },
    final(Array.from({ length: 24 }, (_, i) => `Already read synthetic paragraph ${i}.`).join('\n\n')),
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = digest();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  win.setSize(1100, 820); win.show(); win.focus();
  await e('sessionManagerApp.chooseCodexFile()'); await pause(200);
  const point = await e(`(()=>{
    const r=document.querySelector('.read-shell'),b=r.getBoundingClientRect();
    const anchor=document.querySelectorAll('.read-section')[2].querySelectorAll('p')[1];
    window.__bottomUp={start:r.scrollTop,height:r.scrollHeight,maxHeightChange:0,maxTextShift:0,
      anchorVisibleOnLoad:false,loaded:false};
    const y=anchor.getBoundingClientRect().top+r.scrollTop;
    function sample(){const a=anchor.getBoundingClientRect(),b=r.getBoundingClientRect();
      __bottomUp.maxTextShift=Math.max(__bottomUp.maxTextShift,Math.abs(a.top+r.scrollTop-y));
      __bottomUp.maxHeightChange=Math.max(__bottomUp.maxHeightChange,Math.abs(r.scrollHeight-__bottomUp.height));
      if(document.querySelector('.attachment-preview img')?.naturalWidth){
        if(!__bottomUp.loaded)__bottomUp.anchorVisibleOnLoad=a.top>=b.top&&a.bottom<=b.bottom;
        __bottomUp.loaded=true;
      }
      __bottomUp.frame=requestAnimationFrame(sample);
    }sample();
    return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2),
      atBottom:Math.abs(r.scrollHeight-r.clientHeight-r.scrollTop)<=1,
      unloaded:!document.querySelector('.attachment-preview img')};
  })()`);
  check('bottom-up: opens at latest with image above still unloaded', point.atBottom && point.unloaded);
  let steps = 0;
  for (; steps < 600;) {
    for (let n = 0; n < 10; n++, steps++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y,
        deltaX: 0, deltaY: 2, hasPreciseScrollingDeltas: true, canScroll: true });
      await pause(24);
    }
    if (await e('__bottomUp.loaded')) break;
  }
  await pause(500);
  const observed = await e(`(()=>{cancelAnimationFrame(__bottomUp.frame);
    return {...__bottomUp,end:document.querySelector('.read-shell').scrollTop};})()`);
  fs.writeFileSync(path.join(base, 'image-bottom-up.json'), JSON.stringify({ ...observed, steps }, null, 2));
  check('bottom-up: loading keeps text and page geometry stable', observed.maxHeightChange<=1 && observed.maxTextShift<=1);
  check('bottom-up: first load occurs with previously read text visible', observed.loaded && observed.anchorVisibleOnLoad);
  check('bottom-up: image adds no displacement to the precise wheel movement', Math.abs(observed.start-observed.end-steps*2)<=1);
  check('bottom-up: source remains unchanged', digest() === before);
  await e('delete window.__bottomUp');
};
