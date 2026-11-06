'use strict';
// Observe the real main reader inside the isolated synthetic harness. No new
// renderer/production IPC capability is added for these measurements.
module.exports = function install(app) {
  const module = require(app.getAppPath() + '/lib/codex-page-reader-v2');
  const original = module.createConversationReader, readers = [];
  module.createConversationReader = (...args) => { const reader = original(...args); readers.push(reader); return reader; };
  return async ({ base, e, check, dialog }) => {
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const navigate = require('./page-navigation.cjs');
    const file = path.join(base, 'rollout-append-ui.jsonl');
    const row = (type, extra) => JSON.stringify({ type: 'event_msg', payload: { type, ...extra } }) + '\n';
    const turn = n => row('user_message', { message: `Synthetic append question ${n}` }) + row('task_complete', { last_agent_message: `Synthetic append final ${n}` });
    let expected = Array.from({ length: 115 }, (_, n) => turn(n)).join('');
    fs.writeFileSync(file, expected);
    const unchanged = () => assert.equal(fs.readFileSync(file, 'utf8'), expected);
    const append = text => { unchanged(); fs.appendFileSync(file, text); expected += text; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    assert.ok(await e('sessionManagerApp.chooseCodexFile()'));
    await e('codexLive.tick()');
    const reader = readers.find(reader => reader.getSource()?.filePath === file);
    assert.ok(reader);
    append(turn(115)); await e('codexLive.tick()');
    check('automatic update parses only appended records and follows latest', reader.getReadWork().incremental &&
      reader.getReadWork().parsedRecords === 2 && await e("document.getElementById('readMount').textContent.includes('Synthetic append final 115') && sessionManagerApp.isFollowingLatest()"));
    await navigate(e, 'previous'); await e("document.querySelector('.read-shell').scrollTop=140");
    const before = await e("({text:document.getElementById('readMount').textContent,top:document.querySelector('.read-shell').scrollTop})");
    append(turn(116)); await e('codexLive.tick()');
    check('incremental update does not interrupt historical reading', await e(`document.getElementById('readMount').textContent===${JSON.stringify(before.text)} && document.querySelector('.read-shell').scrollTop===${before.top} && !document.getElementById('codexNewMessages').hidden`));
    await e('codexLive.latest()');
    check('explicit latest reuses checkpoint after historical reading', reader.getReadWork().incremental && reader.getReadWork().parsedRecords === 2 &&
      await e("document.getElementById('readMount').textContent.includes('Synthetic append final 116')"));
    unchanged(); expected = expected.replace('question 0', 'modified 0') + turn(117); fs.writeFileSync(file, expected);
    await e('codexLive.tick()');
    check('rewritten history plus growth safely falls back in the actual app', !reader.getReadWork().incremental &&
      await e("document.getElementById('readMount').textContent.includes('Synthetic append final 117')"));
    const final = row('task_complete', { last_agent_message: 'Completed split record' });
    append(final.slice(0, 30)); await e('codexLive.tick()');
    append(final.slice(30)); await e('codexLive.tick()');
    check('split last record recovers through a complete reread', !reader.getReadWork().incremental &&
      await e("document.getElementById('readMount').textContent.includes('Completed split record')"));
    unchanged(); check('incremental UI reads never modify synthetic source', true);
  };
};
