// Runs only inside the isolated synthetic upgrade harness, before product main.
module.exports = function install(base, stage) {
  const { app, dialog, session } = require('electron');
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const path = require('node:path');
  app.setPath('home', path.join(base, 'home'));
  app.setPath('userData', path.join(base, 'profile'));
  app.setPath('sessionData', path.join(base, 'profile'));
  let chooserCalls = 0;
  dialog.showOpenDialog = async () => {
    chooserCalls++;
    return { canceled: false, filePaths: [path.join(base, 'source')] };
  };
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', async () => {
      const checks = [], errors = [];
      const e = code => win.webContents.executeJavaScript(code, true);
      const check = (name, value) => { assert.ok(value, name); checks.push(name); };
      try {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (stage === 'seed') await e('sessionManagerApp.chooseCodexFolder()');
        for (let n = 0; n < 100; n++) {
          if (await e('sessionManagerApp.getState().folder?.entries?.length===1')) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        check('saved source opens with one synthetic session', await e('sessionManagerApp.getState().folder?.entries?.length===1'));
        check('no repeated source chooser', chooserCalls === (stage === 'seed' ? 1 : 0));
        await e('sessionManagerApp.openCodexCatalogEntry(sessionManagerApp.getState().folder.entries[0].entryId)');
        if (stage === 'seed') {
          await e("readerShell.setPreference('font','xxxxlarge');readerShell.setPreference('theme','dark');readerShell.setPreference('width','wide');document.getElementById('readerFavorite').click()");
        }
        check('26px font survives restart/replacement', await e("getComputedStyle(document.getElementById('readMount')).fontSize==='26px'"));
        check('theme and width survive restart/replacement', await e("document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.width==='wide'"));
        check('favorite survives restart/replacement', await e('sessionManagerApp.getSelectedFavorite()'));
        check('prompt and final reply remain readable', await e("document.getElementById('readMount').textContent.includes('Synthetic final reply')&&document.querySelectorAll('.read-section').length===2"));
        const saved = await e('JSON.stringify(Object.entries(localStorage).sort(([a],[b])=>a.localeCompare(b)))');
        const baseline = path.join(base, 'saved-settings.json');
        if (stage === 'seed') fs.writeFileSync(baseline, saved);
        else check('stored preferences and favorites unchanged', saved === fs.readFileSync(baseline, 'utf8'));
        await session.defaultSession.flushStorageData();
      } catch (error) { errors.push(error.message); }
      fs.writeFileSync(path.join(base, stage + '.json'), JSON.stringify({
        stage, version: app.getVersion(), electron: process.versions.electron,
        packaged: app.isPackaged, checks, errors,
      }, null, 2));
      app.quit();
    });
  });
};
