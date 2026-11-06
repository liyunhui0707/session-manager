'use strict';
const navigate = require('./page-navigation.cjs');
module.exports = async function ({ base, fixture, win, check, e }) {
  const { dialog } = require('electron'), fs = require('node:fs');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.zstdPath] });
  await e('sessionManagerApp.chooseCodexFile()');
  const latest = await e("document.getElementById('readMount').textContent");
  check('compressed long file opens bounded latest Markdown', latest.includes('Message ' + fixture.lastMessage) && await e("document.querySelectorAll('.read-section').length<=100"));
  check('compressed progress uses conversation parts, not invented percentage', await e("document.getElementById('transcriptPageStatus').textContent.includes('第 ') && !document.getElementById('transcriptPageStatus').textContent.includes('%')"));
  await navigate(e, 'previous');
  check('compressed Previous reads older bounded content', await e("document.querySelectorAll('.read-section').length===100 && !document.getElementById('transcriptNext').disabled"));
  await navigate(e, 'next');
  check('compressed Next restores same latest content', latest === await e("document.getElementById('readMount').textContent"));
  await e('sessionManagerApp.reloadCodexFile()');
  check('compressed Reload and Refresh boundary preserved', latest === await e("document.getElementById('readMount').textContent") && await e("document.getElementById('refreshButton').disabled"));
  await new Promise(resolve => setTimeout(resolve, 120));
  fs.writeFileSync(base + '/zstd-reader.png', (await win.webContents.capturePage()).toPNG());
  await e('sessionManagerApp.backToLibrary()');
};
