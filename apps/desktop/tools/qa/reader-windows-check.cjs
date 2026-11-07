'use strict';
module.exports = async ({ base, win, e, check, dialog, manualShortcut = false }) => {
  const { app, BrowserWindow, Menu } = require('electron');
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(base, 'multi-window-source'), dir = path.join(root, 'sessions/2026/11/07');
  fs.mkdirSync(dir, { recursive: true });
  const ids = ['eeeeeeee-eeee-4eee-8eee-000000000001', 'eeeeeeee-eeee-4eee-8eee-000000000002'];
  const files = ids.map((id, index) => {
    const file = path.join(dir, `rollout-2026-11-07T00-00-00-${id}.jsonl`);
    const body = JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli' } }) + '\n' +
      Array.from({ length: 240 }, (_, n) => ['user_message', 'task_complete'].map(type => JSON.stringify({ type: 'event_msg',
        payload: { type, [type === 'user_message' ? 'message' : 'last_agent_message']: `Window ${index} message ${n}. ` + 'Synthetic paragraph. '.repeat(15) } })).join('\n')).join('\n') + '\n';
    fs.writeFileSync(file, body); return { file, body };
  });
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), ids.map((id, index) => JSON.stringify({ id, thread_name: `Synthetic window ${index}`, updated_at: '2026-11-07T00:00:00Z' })).join('\n') + '\n');
  const wait = async (predicate, attempts = 150) => {
    for (let n = 0; n < attempts; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw Error('Multi-window condition timed out');
  };
  const code = window => text => window.webContents.executeJavaScript(text, true);
  const state = 'sessionManagerApp.getState()';
  const ready = window => wait(() => code(window)(`typeof sessionManagerApp !== 'undefined' && ${state}.folder.entries.length===2 && !sessionManagerApp.isBusy()`));
  const open = async (run, id) => run(`sessionManagerApp.openCodexCatalogEntry(${state}.folder.entries.find(x=>x.sessionId===${JSON.stringify(id)}).entryId)`);
  const remaining = new Set(BrowserWindow.getAllWindows());
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  await e('sessionManagerApp.chooseCodexFolder()'); await open(e, ids[0]);
  const menu = Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items[0];
  check('native File menu exposes CmdOrCtrl+N', menu.accelerator === 'CmdOrCtrl+N');
  win.focus();
  // Electron's renderer sendInputEvent does not dispatch native macOS menu accelerators.
  if (manualShortcut) fs.writeFileSync(path.join(base, 'shortcut-ready'), 'Press Cmd+N in the synthetic QA window.');
  else menu.click();
  await wait(() => BrowserWindow.getAllWindows().some(window => !remaining.has(window)), manualShortcut ? 18000 : 150);
  const second = BrowserWindow.getAllWindows().find(window => !remaining.has(window));
  const b = code(second); await ready(second);
  check('new window inherits source without changing parent selection', await e(`${state}.folder.selectedSessionId===${JSON.stringify(ids[0])}`) && await b(`${state}.folder.selectedSessionId===null`));
  await open(b, ids[1]);
  check('two windows display different conversations', await e("document.getElementById('readMount').textContent.includes('Window 0')") && await b("document.getElementById('readMount').textContent.includes('Window 1')"));
  await wait(() => win.getTitle() !== second.getTitle());
  check('native window titles identify their conversations', win.getTitle().includes('Synthetic window 0') && second.getTitle().includes('Synthetic window 1'));
  const parentBefore = await e("({text:document.getElementById('readMount').textContent,scroll:document.querySelector('.read-shell').scrollTop})");
  await require('./page-navigation.cjs')(b, 'previous');
  check('paging another window preserves parent body and scroll', await e(`document.getElementById('readMount').textContent===${JSON.stringify(parentBefore.text)} && document.querySelector('.read-shell').scrollTop===${parentBefore.scroll}`));
  const result = await b("sessionApi.searchCodexConversations('message 12', 'current')");
  check('independent window search returns results', result.ok && result.hits.length > 0);
  check('search hit cannot cross windows', !(await e(`sessionApi.openCodexSearchHit(${JSON.stringify(result.hits[0].hitId)})`)).ok);
  await b('sessionApi.cancelCodexSearch()');
  check('cancelling other-window search leaves parent usable', await e('sessionManagerApp.reloadCodexFolderEntry()'));
  await b("readerShell.setPreference('font','xxxlarge')");
  await wait(() => e("document.documentElement.dataset.font==='xxxlarge'"));
  check('appearance synchronizes across windows', true);
  await b('sessionManagerApp.toggleSelectedFavorite()');
  await wait(() => e(`!!document.querySelector('[data-entry-id="'+${state}.folder.entries.find(x=>x.sessionId===${JSON.stringify(ids[1])}).entryId+'"] .session-star--on')`));
  check('favorites synchronize across windows', true);
  second.setSize(900, 600);
  check('new-window controls fit minimum size', await b('document.documentElement.scrollWidth<=innerWidth'));
  fs.writeFileSync(path.join(base, 'multi-window.png'), (await second.webContents.capturePage()).toPNG());
  if (manualShortcut) {
    fs.writeFileSync(path.join(base, 'desktop-check-ready'), 'Two synthetic windows are ready for native desktop checks.');
    await wait(() => fs.existsSync(path.join(base, 'desktop-check-continue')), 18000);
  }
  const original = Menu.buildFromTemplate;
  let captured;
  Menu.buildFromTemplate = template => {
    if (template.length === 1 && template[0].label === '在新窗口打开') {
      captured = template[0]; return { popup() {} };
    }
    return original.call(Menu, template);
  };
  let third;
  try {
    const menuTarget = await b(`${state}.folder.entries.find(entry=>entry.entryId===document.querySelector('.session-row').getAttribute('data-entry-id')).sessionId`);
    await b("document.querySelector('.session-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
    await wait(() => !!captured);
    check('sidebar context menu offers open in new window', captured.label === '在新窗口打开');
    const existing = new Set(BrowserWindow.getAllWindows()); captured.click();
    await wait(() => BrowserWindow.getAllWindows().some(window => !existing.has(window)));
    third = BrowserWindow.getAllWindows().find(window => !existing.has(window)); await ready(third);
    await wait(() => code(third)(`${state}.folder.selectedSessionId!==null`));
    check('context menu opens its chosen conversation in a third window', await code(third)(`${state}.folder.selectedSessionId===${JSON.stringify(menuTarget)}`));
  } finally { Menu.buildFromTemplate = original; }
  second.close();
  check('closing one window leaves other readers working', await e('sessionManagerApp.reloadCodexFolderEntry()') && await code(third)('sessionManagerApp.reloadCodexFolderEntry()'));
  third.close();
  // Direct-file windows retain only the explicitly chosen file capability.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files[0].file] });
  await e('sessionManagerApp.chooseCodexFile()');
  const existing = new Set(BrowserWindow.getAllWindows());
  await e('document.getElementById("newWindowButton").click()');
  await wait(() => BrowserWindow.getAllWindows().some(window => !existing.has(window)));
  const direct = BrowserWindow.getAllWindows().find(window => !existing.has(window));
  await wait(() => code(direct)(`typeof sessionManagerApp !== 'undefined' && ${state}.sourceMode==='codex' && !sessionManagerApp.isBusy()`));
  check('sidebar new-window button duplicates direct-file source safely', await code(direct)("document.getElementById('readMount').textContent.includes('Window 0')"));
  direct.close();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(base, 'shell-library')] });
  await e('sessionManagerApp.chooseLibrary()');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  await e('sessionManagerApp.chooseCodexFolder()'); await e('sessionManagerApp.backToLibrary()');
  captured = null;
  Menu.buildFromTemplate = template => {
    if (template.length === 1 && template[0].label === '在新窗口打开') { captured = template[0]; return { popup() {} }; }
    return original.call(Menu, template);
  };
  try {
    const existing = new Set(BrowserWindow.getAllWindows());
    const target = await e("document.querySelector('.session-row').getAttribute('data-note-id')");
    await e("document.querySelector('.session-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
    await wait(() => !!captured); captured.click();
    await wait(() => BrowserWindow.getAllWindows().some(window => !existing.has(window)));
    const library = BrowserWindow.getAllWindows().find(window => !existing.has(window));
    await wait(() => code(library)(`typeof sessionManagerApp !== 'undefined' && ${state}.selectedId!==null`));
    check('library context menu inherits the displayed library after returning from Codex', await code(library)(`${state}.sourceMode==='library' && ${state}.selectedId===${JSON.stringify(target)} && ${state}.sessions.length===2`));
    library.close();
  } finally { Menu.buildFromTemplate = original; }
  win.close(); await wait(() => BrowserWindow.getAllWindows().length === 0); app.emit('activate');
  await wait(() => BrowserWindow.getAllWindows().length === 1);
  const reopened = BrowserWindow.getAllWindows()[0]; await ready(reopened);
  check('macOS activate recreates a working window after all readers close', await code(reopened)('sessionManagerApp.chooseCodexFolder()'));
  reopened.close();
  check('multi-window reading leaves synthetic sources unchanged', files.every(({ file, body }) => fs.readFileSync(file, 'utf8') === body));
};
