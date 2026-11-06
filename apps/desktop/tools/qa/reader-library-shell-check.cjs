'use strict';
module.exports = async function ({ base, win, check, e, dialog }) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const root = path.join(base, 'shell-library');
  const files = [['codex', 'Codex synthetic'], ['claude-code', 'Claude synthetic']].map(([agent, title]) => {
    const dir = path.join(root, agent); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'example.md');
    fs.writeFileSync(file, `---\nagent: ${agent}\nsource_custom_title: ${title}\nsource_ai_title: ${title}\n---\n\n## User\n\nSynthetic library needle\n\n## Assistant\n\n**Readable** Markdown.\n`);
    return file;
  });
  const snapshot = () => files.map(file => [fs.statSync(file).mtimeMs, fs.statSync(file).size, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
  const before = JSON.stringify(snapshot());
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  await e('sessionManagerApp.chooseLibrary()');
  check('Markdown source uses the real library and agent tabs', await e("sessionManagerApp.getState().sessions.length===2 && !document.getElementById('librarySourceTabs').hidden && document.getElementById('codexLive').hidden"));
  await e("document.querySelector('[data-agent=claude]').click()");
  check('Claude library tab filters metadata only', await e("document.querySelectorAll('.session-row').length===1 && document.querySelector('.session-row').textContent.includes('Claude synthetic') && !document.getElementById('readMount').textContent"));
  await e("document.querySelector('.session-row').click()");
  check('library reader renders safe Markdown', await e("document.getElementById('readTitle').textContent==='Claude synthetic' && !!document.querySelector('#readMount strong')"));
  await e("document.getElementById('readerFavorite').click();document.getElementById('favoritesFilter').click()");
  check('header favorite is connected to library favorites', await e("document.getElementById('readerFavorite').getAttribute('aria-pressed')==='true' && document.querySelector('.session-star--on')!==null"));
  await e("document.getElementById('searchLaunch').click()");
  check('library search focuses the actual library index input', await e("document.getElementById('searchDialog').matches(':modal') && document.activeElement.id==='globalSearchInput'"));
  await e("document.getElementById('globalSearchInput').value='needle';sessionManagerApp.searchAll('needle')");
  check('library full-text results remain available', await e("document.querySelectorAll('.sidebar-search-result-row').length===2"));
  await e("document.getElementById('searchDialog').close()");
  check('library UI leaves all synthetic Markdown unchanged', JSON.stringify(snapshot()) === before);
};
