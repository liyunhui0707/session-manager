'use strict';
module.exports = async ({ base, e, check, dialog, win }) => {
  const fs = require('node:fs'), path = require('node:path');
  const file = path.join(base, 'rollout-search-pages.jsonl');
  const body = Array.from({ length: 1250 }, (_, n) => JSON.stringify({ type: 'event_msg',
    payload: { type: 'user_message', message: `分页 needle ${n}` } }) + '\n').join('');
  fs.writeFileSync(file, body, { flag: 'wx' });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  await e('sessionManagerApp.chooseCodexFile()');
  await e("codexLive.search('needle','current')");
  check('search presents 200 bounded results with continuation', await e("document.querySelectorAll('.codex-search-hit').length===200 && !!document.querySelector('.codex-search-more')"));
  const seen = [];
  for (let page = 0; page < 7; page++) {
    seen.push(...await e("Array.from(document.querySelectorAll('.codex-search-hit span'),x=>x.textContent)"));
    if (page === 6) break;
    await e("document.querySelector('.codex-search-more').click()");
    let ready = false;
    for (let n = 0; n < 500; n++) {
      if (await e('!document.getElementById("codexSearchSubmit").disabled')) { ready = true; break; }
      await new Promise(r => setTimeout(r, 20));
    }
    if (!ready) throw Error('Search page did not finish');
  }
  check('all 1250 matches are reachable exactly once', seen.length === 1250 && new Set(seen).size === 1250);
  check('last search page reports completion without a false cap', await e("!document.querySelector('.codex-search-more') && document.getElementById('codexSearchStatus').textContent.includes('搜索完成')"));
  await e("document.querySelector('.codex-search-hit').click()");
  for (let n = 0; n < 500; n++) {
    if (await e("document.getElementById('readMount').textContent.includes('needle 1200') && document.querySelectorAll('mark').length>0 && !sessionManagerApp.isBusy()")) break;
    await new Promise(r => setTimeout(r, 20));
  }
  check('later search page opens and highlights its exact conversation part', await e("document.getElementById('readMount').textContent.includes('needle 1200') && document.querySelectorAll('mark').length>0"));
  check('paginated searches preserve the source bytes', fs.readFileSync(file, 'utf8') === body);
  await new Promise(r => setTimeout(r, 120));
  await e("document.getElementById('codexSearchInput').value='needle';document.getElementById('codexSearchScope').value='current'");
  await e("codexLive.search('needle','current')");
  await e("document.getElementById('searchLaunch').click();document.getElementById('codexSearchResults').scrollTop=document.getElementById('codexSearchResults').scrollHeight");
  await new Promise(r => setTimeout(r, 120));
  fs.writeFileSync(path.join(base, 'search-pages.png'), (await win.webContents.capturePage()).toPNG());
};
