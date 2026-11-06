// node reader-upgrade.mjs '/old/App.app' '/candidate/App.app'
// Tests normal quits and replacement at the same isolated install path. This
// does not simulate Finder/Gatekeeper or claim a browser-quarantined install.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.versions.node.split('.')[0] !== '24') throw Error('Requires macOS and Node 24');
const apps = process.argv.slice(2).map(p => fs.realpathSync(p));
if (apps.length !== 2 || apps.some(p => !p.endsWith('.app'))) throw Error('Expected old and new app paths');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const identity = apps.map(p => ({ asar: hash(path.join(p, 'Contents/Resources/app.asar')) }));
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asm-reader-upgrade-')));
fs.chmodSync(base, 0o700);
for (const dir of ['home/tmp', 'profile', 'source/sessions/2026/11/06', 'install']) fs.mkdirSync(path.join(base, dir), { recursive: true });
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const source = path.join(base, 'source/sessions/2026/11/06', `rollout-2026-11-06T00-00-00-${id}.jsonl`);
fs.writeFileSync(source, [
  { type: 'session_meta', payload: { id, source: 'cli', cwd: '/synthetic/project' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic prompt' } },
  { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Synthetic final reply' } },
].map(x => JSON.stringify(x)).join('\n') + '\n');
const snapshot = () => JSON.stringify({ hash: hash(source), size: fs.statSync(source).size, mtime: fs.statSync(source).mtimeMs });
const before = snapshot();
const installed = path.join(base, 'install/AI Session Manager.app');
const bootstrap = fileURLToPath(new URL('./reader-upgrade-bootstrap.cjs', import.meta.url));
console.log('Upgrade QA evidence:', base);

async function launch(stage) {
  const child = spawn(path.join(installed, 'Contents/MacOS/AI Session Manager'),
    ['--inspect-brk=127.0.0.1:0', '--user-data-dir=' + path.join(base, 'profile')], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), TMPDIR: path.join(base, 'home/tmp'), LANG: 'en_US.UTF-8' },
    });
  let ws, booted = false, sequence = 0, stderr = '', failure = null, watchdog = false;
  const pending = new Map();
  const log = fs.createWriteStream(path.join(base, stage + '.log'), { mode: 0o600 });
  function stop() { ws?.close(); try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  child.on('error', error => { failure = error.message; });
  child.stdout.on('data', data => log.write(data));
  child.stderr.on('data', data => {
    log.write(data);
    if (ws) return;
    stderr = (stderr + data).slice(-16384);
    const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
    if (!match) return;
    ws = new WebSocket(match[0]);
    ws.addEventListener('open', async () => {
      try { await send('Debugger.enable'); await send('Runtime.runIfWaitingForDebugger'); }
      catch { failure = 'inspector-start'; stop(); }
    });
    ws.addEventListener('message', async event => {
      try {
        const m = JSON.parse(event.data);
        if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(m.error) : p?.resolve(m.result); }
        if (m.method !== 'Debugger.paused' || booted) return;
        booted = true;
        const result = await send('Debugger.evaluateOnCallFrame', {
          callFrameId: m.params.callFrames[0].callFrameId,
          expression: `require(${JSON.stringify(bootstrap)})(${JSON.stringify(base)},${JSON.stringify(stage)})`, returnByValue: true,
        });
        if (result.exceptionDetails) throw Error('bootstrap');
        await send('Debugger.resume');
      } catch { failure = 'inspector-bootstrap'; stop(); }
    });
  });
  const file = path.join(base, stage + '.json');
  const poll = setInterval(() => { if (fs.existsSync(file)) ws?.close(); }, 100);
  const timeout = setTimeout(() => { watchdog = true; stop(); }, 60000);
  const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 63000);
  return new Promise(resolve => child.on('close', (code, signal) => {
    clearInterval(poll); clearTimeout(timeout); clearTimeout(kill); ws?.close(); log.end();
    let remaining = false;
    try { process.kill(-child.pid, 0); remaining = true; } catch {}
    const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
    resolve({ stage, code, signal, failure, watchdog, remaining, result,
      passed: code === 0 && !signal && !failure && !watchdog && !remaining && result?.packaged === true
        && result.errors.length === 0 && result.checks.length === (stage === 'seed' ? 6 : 7) });
  }));
}
const stages = [];
try {
  execFileSync('/usr/bin/ditto', [apps[0], installed]);
  for (const stage of ['seed', 'restart', 'upgraded']) {
    if (stage === 'upgraded') {
      fs.renameSync(installed, path.join(base, 'install/previous.app'));
      execFileSync('/usr/bin/ditto', [apps[1], installed]);
    }
    const result = await launch(stage); stages.push(result);
    assert.ok(result.passed, `${stage} failed`);
    assert.equal(snapshot(), before, 'Source unchanged');
  }
} catch (error) { console.error(error.message); }
const report = { passed: stages.length === 3 && stages.every(s => s.passed) && snapshot() === before,
  identity, node: process.version, arch: process.arch, unchanged: snapshot() === before, stages };
fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
