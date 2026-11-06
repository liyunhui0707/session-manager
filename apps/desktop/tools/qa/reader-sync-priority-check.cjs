'use strict';
// Install before production main imports the scanner. Delay only one explicitly
// armed synthetic scan, so the foreground/background race is deterministic.
module.exports = function install(app) {
  const scanner = require(app.getAppPath() + '/lib/codex-source-catalog');
  const original = scanner.scanCodexSource;
  let probe = null;
  scanner.scanCodexSource = async (root, options) => {
    const job = probe;
    if (job && root === job.root && !job.entered) {
      job.entered = true;
      await new Promise(resolve => {
        job.release = resolve;
        options.signal.addEventListener('abort', () => { job.aborted = true; resolve(); }, { once: true });
      });
      if (options.signal.aborted) throw Object.assign(new Error('synthetic cancelled scan'), { code: 'SCAN_CANCELLED' });
    }
    return original(root, options);
  };
  return async ({ base, e, check, dialog }) => {
    const fs = require('node:fs'), path = require('node:path');
    const oldRoot = path.join(base, 'experience-source');
    const newRoot = path.join(base, 'priority-source'), dir = path.join(newRoot, 'sessions/2026/11/05');
    fs.mkdirSync(dir, { recursive: true });
    const id = 'ffffffff-ffff-4fff-8fff-000000000001';
    const file = path.join(dir, `rollout-2026-11-05T00-00-00-${id}.jsonl`);
    const text = JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli' } }) + '\n' +
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic pending prompt' } }) + '\n';
    fs.writeFileSync(file, text);
    probe = { root: oldRoot, entered: false, aborted: false };
    try {
      await e('void codexLive.tick()');
      for (let n = 0; n < 200 && !probe.entered; n++) await new Promise(r => setTimeout(r, 10));
      check('background scan is held at the source-switch boundary', probe.entered);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [newRoot] });
      const opened = await e('sessionManagerApp.chooseCodexFolder()');
      check('source switch interrupts background scan and succeeds on the first click', opened && probe.aborted);
      await new Promise(r => setTimeout(r, 50));
      check('late poll cannot restore previous source and source bytes stay unchanged',
        await e(`sessionManagerApp.getState().folder.entries[0].sessionId===${JSON.stringify(id)}`) && fs.readFileSync(file, 'utf8') === text);
    } finally { probe?.release?.(); probe = null; }
  };
};
