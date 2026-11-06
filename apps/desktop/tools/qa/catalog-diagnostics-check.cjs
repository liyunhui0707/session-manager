// Packaged synthetic selection and diagnostic acceptance; no source writes.
module.exports = async function ({ base, fixture, win, check, e, dialog }) {
  const fs = require('node:fs');
  const path = require('node:path');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.root] });
  await e('sessionManagerApp.chooseCodexFolder()');
  check('valid names survive invalid index metadata', await e(`
    sessionManagerApp.getState().folder.entries.some(x => x.title === 'A calmer way to read') &&
    document.getElementById('folderDiagnostics').textContent.includes('1 项名称索引错误')`));
  check('full root name coverage visible', await e(`
    !document.getElementById('folderSourceNotice').hidden &&
    document.getElementById('folderSourceNotice').textContent.includes('6 个未归档对话中，6 个已读取名称')`));
  check('excluded formats explained', await e(`
    document.getElementById('folderSourceNotice').textContent.includes('已排除 2 项') &&
    document.getElementById('folderDiagnostics').textContent.includes('1 项压缩文件名不支持') &&
    document.getElementById('folderDiagnostics').textContent.includes('1 项文件名不支持')`));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(fixture.root, 'sessions')] });
  await e('sessionManagerApp.chooseCodexFolder()');
  check('active-only scope and missing title index explained', await e(`
    document.getElementById('folderSourceNotice').textContent.includes('仅显示未归档对话') &&
    document.getElementById('folderDiagnostics').textContent.includes('session_index.jsonl') &&
    sessionManagerApp.getState().folder.entries.every(x => x.title === x.sessionId.slice(0, 8))`));
  fs.writeFileSync(base + '/active-only-layout.json', JSON.stringify(await e("({ listHeight: document.querySelector('.session-list').getBoundingClientRect().height, noticeHeight: document.getElementById('folderSourceNotice').getBoundingClientRect().height, viewportHeight: innerHeight })")));
  check('active-only list retains room with details open', await e("document.querySelector('.session-list').getBoundingClientRect().height >= 84"));
  fs.writeFileSync(base + '/active-only-notice.png', (await win.webContents.capturePage()).toPNG());
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.root] });
  await e('sessionManagerApp.chooseCodexFolder()');
  check('explicit full-root selection restores names', await e(`
    document.getElementById('folderSourceNotice').textContent.includes('6 个未归档对话中，6 个已读取名称') &&
    sessionManagerApp.getState().folder.entries.length === 6`));
  await e('sessionManagerApp.rescanCodexFolder()');
  check('Rescan retains accurate name coverage and reasons', await e(`
    document.getElementById('folderSourceNotice').textContent.includes('6 个未归档对话中，6 个已读取名称') &&
    document.getElementById('folderDiagnostics').textContent.includes('1 项压缩文件名不支持')`));
  fs.writeFileSync(base + '/full-root-notice.png', (await win.webContents.capturePage()).toPNG());
};
