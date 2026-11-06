'use strict';
// Twelve-minute isolated UI soak, real packaged workers/renderer, no forced GC.
module.exports = async ({ base, win, e: evaluate, check, dialog }) => {
  const { app } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const file = path.join(base, 'rollout-soak.jsonl'), imageFile = path.join(base, 'automatic-images/rollout-images.jsonl');
  const body = Array.from({ length: 3500 }, (_, n) => JSON.stringify({ type: 'event_msg',
    payload: { type: 'user_message', message: `Soak needle ${n} **中文**` } }) + '\n').join('');
  fs.writeFileSync(file, body, { flag: 'wx' });
  const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const before = [hash(file), hash(imageFile)], samples = [], start = Date.now();
  const visibilityRecoveries = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let cycleNumber = 0;
  const e = async code => {
    try { return await evaluate(code); }
    catch (error) { throw Error(`Soak cycle ${cycleNumber}, operation ${code}: ${error.message}`); }
  };
  async function until(condition, label) {
    let restored = false;
    for (let n = 0; n < 400; n++) {
      if (await e(condition)) return;
      // Occluded macOS windows suspend IntersectionObserver delivery. Restore
      // the actual test window, not renderer visibility or product observers.
      if (!restored && await e("document.visibilityState==='hidden'")) {
        visibilityRecoveries.push({ cycle: cycleNumber, operation: label });
        win.show(); win.focus(); restored = true;
      }
      await sleep(20);
    }
    const state = await e(`JSON.stringify({busy:sessionManagerApp.isBusy(),images:document.querySelectorAll('.attachment-preview img').length,
      modals:document.querySelectorAll('.image-lightbox[open]').length,hits:document.querySelectorAll('.codex-search-hit').length,
      visibility:document.visibilityState,focus:document.hasFocus(),
      dialogs:Array.from(document.querySelectorAll('dialog[open]'),n=>n.id||n.className),
      rect:document.querySelector('.attachment-controls')?.getBoundingClientRect().toJSON(),
      notes:Array.from(document.querySelectorAll('.attachment-note'),n=>n.textContent)})`);
    fs.writeFileSync(path.join(base,'soak-failure.png'),(await win.webContents.capturePage()).toPNG());
    throw Error(`Soak cycle ${cycleNumber}: ${label} did not complete. ${state}`);
  }
  await e(`window.__soakURLs=new Set();window.__soakCreate=URL.createObjectURL;window.__soakRevoke=URL.revokeObjectURL;
    URL.createObjectURL=function(b){const u=window.__soakCreate.call(URL,b);window.__soakURLs.add(u);return u;};
    URL.revokeObjectURL=function(u){window.__soakURLs.delete(u);return window.__soakRevoke.call(URL,u);};void 0;`);
  await e("document.getElementById('searchDialog').close()");
  let urlsClosed = true;
  try {
    for (let cycle = 0; cycle < 360; cycle++) {
      cycleNumber = cycle + 1;
      const at = Date.now();
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      if (!await e('sessionManagerApp.chooseCodexFile()')) throw Error('Soak source did not open');
      await e("codexLive.search('needle','current')");
      await e("codexLive.search('needle','current')");
      await until("!!document.querySelector('.codex-search-hit') && !sessionManagerApp.isBusy()", 'search results');
      await e("document.querySelector('.codex-search-hit').click()");
      await until("document.getElementById('readMount').textContent.includes('Soak needle 0 ') && document.querySelectorAll('mark').length>0 && !sessionManagerApp.isBusy()", 'search-hit navigation');
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imageFile] });
      if (!await e('sessionManagerApp.chooseCodexFile()')) throw Error('Soak source did not open');
      await until("document.querySelector('.attachment-preview img')?.naturalWidth===800", 'image preview');
      await e("document.querySelector('.attachment-preview img').click()");
      await until("document.querySelector('.image-lightbox[open] img')?.naturalWidth===5120", 'image enlargement');
      await e("document.querySelector('.image-lightbox').close()");
      await until("!document.querySelector('.image-lightbox')", 'image closure');
      // An occluded preview may also be released. Every remaining URL must
      // belong to a displayed thumbnail; no original-image URL may survive.
      await until("window.__soakURLs.size===document.querySelectorAll('.attachment-preview img').length && window.__soakURLs.size<=1", 'image URL release');
      const metrics = app.getAppMetrics();
      samples.push({ cycle, elapsedMs: Date.now()-start, totalBytes: metrics.reduce((n,p)=>n+p.memory.workingSetSize*1024,0),
        processes: metrics.length, rendererNodes: await e('document.querySelectorAll("*").length') });
      if (cycle % 15 === 14) fs.writeFileSync(path.join(base,'soak-progress.json'),JSON.stringify({cycle:cycle+1,samples},null,2));
      await sleep(Math.max(0, 2000-(Date.now()-at)));
    }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    await e('sessionManagerApp.chooseCodexFile()');
    urlsClosed = urlsClosed && await e('window.__soakURLs.size===0');
    const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const warm = median(samples.slice(30,60).map(x=>x.totalBytes)), end = median(samples.slice(-30).map(x=>x.totalBytes));
    fs.writeFileSync(path.join(base,'soak.json'),JSON.stringify({warmMedian:warm,endMedian:end,visibilityRecoveries,samples},null,2));
    check('twelve-minute 360-cycle soak releases every image URL across source switches', urlsClosed);
    check('soak working-set median growth stays below 96 MiB after warmup', end-warm < 96*1024**2);
    check('soak process and DOM counts remain bounded', Math.max(...samples.map(s=>s.processes)) <= samples[30].processes+1 && Math.max(...samples.map(s=>s.rendererNodes)) < 2000);
    check('soak never changes synthetic conversations', hash(file)===before[0] && hash(imageFile)===before[1]);
    fs.writeFileSync(path.join(base,'soak.json'),JSON.stringify({scope:'360 cycles, >=12 minutes, no forced GC; working sets sum shared pages. A bounded soak, not proof against all leaks.',warmMedian: warm,endMedian:end,visibilityRecoveries,samples},null,2));
  } finally {
    await e('URL.createObjectURL=window.__soakCreate;URL.revokeObjectURL=window.__soakRevoke;delete window.__soakCreate;delete window.__soakRevoke;delete window.__soakURLs');
  }
};
