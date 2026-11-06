'use strict';
// Optional warmed-app measurements. All files are generated here or by this
// isolated harness. No real source, forced GC, or global profile is used.
module.exports = async ({ base, e, check, dialog }) => {
  const { app } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const { pipeline } = require('node:stream/promises');
  const { createZstdCompress } = require('node:zlib');
  const report = { scope: 'Warmed packaged Electron app; sum of working sets may count shared pages twice. Native catalog helper excluded. 50ms sampling, not an absolute OS peak. No forced GC.', samples: [], runs: [], imageCycles: [] };
  const memory = () => {
    const processes = app.getAppMetrics().map(p => ({ type: p.type, pid: p.pid, bytes: p.memory.workingSetSize * 1024 }));
    return { totalBytes: processes.reduce((sum, p) => sum + p.bytes, 0), processes };
  };
  let peak = 0;
  const sample = () => { const m = memory(); peak = Math.max(peak, m.totalBytes); return m; };
  const timer = setInterval(sample, 50);
  const hash = async file => { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); };
  async function until(expression, attempts = 200) {
    for (let i = 0; i < attempts; i++) { if (await e(expression)) return true; await new Promise(r => setTimeout(r, 20)); }
    return false;
  }
  try {
    report.samples.push({ phase: 'before', ...sample() });
    await e(`window.__resourceURLs=new Set();window.__createURL=URL.createObjectURL;window.__revokeURL=URL.revokeObjectURL;
      URL.createObjectURL=function(blob){const url=window.__createURL.call(URL,blob);window.__resourceURLs.add(url);return url;};
      URL.revokeObjectURL=function(url){window.__resourceURLs.delete(url);return window.__revokeURL.call(URL,url);};void 0;`);
    const imageFile = path.join(base, 'automatic-images/rollout-images.jsonl');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imageFile] });
    await e('sessionManagerApp.chooseCodexFile()');
    check('resource fixture image is readable', await until("document.querySelector('.attachment-preview img')?.naturalWidth===800"));
    let closed = true;
    for (let n = 0; n < 12; n++) {
      await e("document.querySelector('.attachment-preview img').click()");
      if (!await until("document.querySelector('.image-lightbox[open] img')?.naturalWidth===5120")) throw Error('Synthetic image did not open');
      const enlarged = sample();
      await e("document.querySelector('.image-lightbox').close()");
      await until("!document.querySelector('.image-lightbox')");
      closed = closed && await e('window.__resourceURLs.size===1');
      report.imageCycles.push({ cycle: n + 1, enlargedBytes: enlarged.totalBytes, closedBytes: sample().totalBytes });
    }
    check('twelve image enlargements release every original URL and modal', closed);
    const root = path.join(base, 'resource-source'); fs.mkdirSync(root);
    const row = ['user', 'assistant'].map(role => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, phase: role === 'assistant' ? 'final_answer' : undefined,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: 'Synthetic resource needle 中文 ' + 'Readable. '.repeat(120) }] } }) + '\n').join('');
    const block = Buffer.from(row.repeat(64));
    for (const mib of [64, 256]) {
      const raw = path.join(root, `rollout-resource-${mib}.jsonl`), compressed = raw + '.zst';
      const fd = fs.openSync(raw, 'wx', 0o600); let bytes = 0;
      try { while (bytes < mib * 1024 ** 2) bytes += fs.writeSync(fd, block); } finally { fs.closeSync(fd); }
      await pipeline(fs.createReadStream(raw), createZstdCompress(), fs.createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
      for (const file of [raw, compressed]) {
        const before = await hash(file); peak = sample().totalBytes;
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        let start = performance.now(); const opened = await e('sessionManagerApp.chooseCodexFile()'); const openMs = performance.now() - start;
        const latest = await e("document.getElementById('transcriptPageStatus').textContent.includes('已到最新') && document.getElementById('readMount').textContent.includes('resource needle')");
        start = performance.now(); await e("document.getElementById('transcriptPrevious').click()");
        const moved = await until("!sessionManagerApp.isBusy() && !document.getElementById('transcriptNext').disabled", 2000); const previousMs = performance.now() - start;
        start = performance.now(); await e("codexLive.search('resource needle','current')"); const searchMs = performance.now() - start;
        const hits = await e("document.querySelectorAll('.codex-search-hit').length");
        const readOnly = before === await hash(file);
        report.runs.push({ decodedBytes: bytes, format: file.endsWith('.zst') ? 'zstd' : 'raw', storedBytes: fs.statSync(file).size,
          opened, latest, moved, hits, readOnly, openMs, previousMs, searchMs, sampledPeakBytes: peak, after: sample() });
        check(`packaged ${mib} MiB ${file.endsWith('.zst') ? 'zstd' : 'raw'} reads latest, navigates and searches without source writes`, opened && latest && moved && hits === 200 && readOnly);
      }
    }
    check('leaving image conversation releases all measured image URLs', await e('window.__resourceURLs.size===0'));
    report.samples.push({ phase: 'after', ...sample() });
  } finally {
    clearInterval(timer);
    await e('URL.createObjectURL=window.__createURL;URL.revokeObjectURL=window.__revokeURL;delete window.__createURL;delete window.__revokeURL;delete window.__resourceURLs');
    fs.writeFileSync(path.join(base, 'resources.json'), JSON.stringify(report, null, 2));
  }
};
