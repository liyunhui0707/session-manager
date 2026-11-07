// Run on either Mac: node reader-smoke.mjs '/path/to/AI Session Manager.app'
// Uses only invented data, a fresh profile, and a loopback inspector bootstrap.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { zstdCompressSync, createZstdCompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) !== 24) {
  throw Error('Requires macOS and Node 24');
}
const app = fs.realpathSync(process.argv[2]);
const contents = path.join(app, 'Contents');
const binary = path.join(contents, 'MacOS', 'AI Session Manager');
const asar = path.join(contents, 'Resources', 'app.asar');
if (!app.endsWith('.app') || !fs.statSync(asar).isFile()) throw Error('Expected packaged app');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asm-reader-smoke-')));
fs.chmodSync(base, 0o700);
const root = path.join(base, 'source');
const directory = path.join(root, 'sessions', '2026', '11', '01');
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(path.join(base, 'profile', 'tmp'), { recursive: true });
const titles = ['A calmer way to read', 'Notes on a weekend project', 'Learning something new',
  'Making room for good ideas', 'Working through a problem', 'A small design decision'];
const entries = titles.map((title, n) => {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  const messages = [
    ['user', 'How can we make this app feel like a quiet place to return to?'],
    ['assistant', '# Start with the conversation\n\nGive the words room to breathe.\n\n'
      + '## Three useful principles\n\n- Clear hierarchy\n- Comfortable reading\n- Quiet details\n\n'
      + '```js\nconst reader = { local: true, readOnly: true };\n```\n\n'
      + '| Feature | Purpose |\n| --- | --- |\n| Search | Find earlier words |'],
    ['user', '也请保留中文内容，让阅读体验自然。'],
    ['assistant', '当然。保留原始顺序，只展示用户提示词和助手回复。'],
  ].map(([role, text]) => ({ type: 'response_item', payload: {
    type: 'message', role, phase: role === 'assistant' ? 'final_answer' : undefined, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  } }));
  const content = messages.map(item => JSON.stringify(item)).join('\n') + '\n';
  fs.writeFileSync(path.join(directory, `rollout-2026-11-01T00-00-00-${id}.jsonl` + (n === 0 ? '.zst' : '')),
    n === 0 ? zstdCompressSync(content) : content, { flag: 'wx' });
  return { id, thread_name: title, updated_at: '2026-11-01T00:00:00Z' };
});
fs.writeFileSync(path.join(root, 'session_index.jsonl'), [...entries, { id: entries[0].id, unrelated: true }].map(x => JSON.stringify(x)).join('\n') + '\n');
// Unsupported synthetic entries must be explained, without decoding their bodies.
fs.writeFileSync(path.join(directory, 'rollout-unsupported.jsonl.zst'), 'synthetic compressed placeholder');
fs.writeFileSync(path.join(directory, `rollout-2026-11-01T00-00-00-${entries[0].id}_${entries[1].id}.jsonl`), 'synthetic unsupported filename');
const longMode = process.argv.includes('--long');
const resources = process.argv.includes('--resources');
const soak = process.argv.includes('--soak');
let longPath = null, zstdPath = null, lastMessage = null;
if (longMode) {
  longPath = path.join(root, 'rollout-long-synthetic.jsonl');
  const fd = fs.openSync(longPath, 'wx', 0o600);
  try {
    let written = 0, index = 0;
    while (written < 64 * 1024 * 1024) {
      const record = JSON.stringify({ type: 'response_item', payload: { type: 'message',
        role: index % 2 ? 'assistant' : 'user', phase: index % 2 ? 'final_answer' : undefined, content: [{ type: 'input_text',
          text: `Message ${index++}\n\n` + 'Synthetic long conversation. 中文。 '.repeat(64) }] } }) + '\n';
      written += fs.writeSync(fd, record); lastMessage = index - 1;
    }
  } finally { fs.closeSync(fd); }
}
if (longMode) {
  zstdPath = longPath + '.zst';
  await pipeline(fs.createReadStream(longPath), createZstdCompress(), fs.createWriteStream(zstdPath, { flags: 'wx', mode: 0o600 }));
}
fs.writeFileSync(path.join(base, 'paths.json'), JSON.stringify({ root, id: entries[0].id, longPath, zstdPath, lastMessage, resources, soak, manualShortcut: process.argv.includes('--manual-shortcut') }));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function snapshot(dir) {
  const rows = [];
  function visit(relative) {
    const p = path.join(dir, relative), st = fs.lstatSync(p, { bigint: true });
    if (st.isSymbolicLink()) throw Error('Unexpected fixture symlink');
    const row = { relative, mode: String(st.mode), size: String(st.size), mtime: String(st.mtimeNs) };
    if (st.isDirectory()) {
      row.names = fs.readdirSync(p).sort(); rows.push(row);
      for (const name of row.names) visit(path.join(relative, name));
    } else { row.sha256 = hash(p); rows.push(row); }
  }
  visit(''); return JSON.stringify(rows);
}
const before = snapshot(root);
const bootstrap = fileURLToPath(new URL('./reader-smoke-bootstrap.cjs', import.meta.url));
const started = Date.now();
const child = spawn(binary, ['--inspect-brk=127.0.0.1:0', '--user-data-dir=' + path.join(base, 'profile')], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'profile'),
    TMPDIR: path.join(base, 'profile', 'tmp'), LANG: 'en_US.UTF-8' },
});
console.log('Synthetic QA evidence:', base);
let ws, sequence = 0, booted = false, watchdog = false, failure = null, stderr = '';
const pending = new Map();
const log = fs.createWriteStream(path.join(base, 'runtime.log'), { mode: 0o600 });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
function terminate() {
  ws?.close();
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
}
child.on('error', () => { failure = 'spawn-error'; });
child.stdout.on('data', d => log.write(d));
child.stderr.on('data', d => {
  log.write(d);
  if (ws) return;
  stderr = (stderr + d).slice(-16384);
  const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
  if (!match) return;
  ws = new WebSocket(match[0]);
  ws.addEventListener('open', async () => {
    try { await send('Debugger.enable'); await send('Runtime.runIfWaitingForDebugger'); }
    catch { failure = 'inspector-start'; terminate(); }
  });
  ws.addEventListener('message', async event => {
    try {
      const m = JSON.parse(event.data);
      if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(m.error) : p?.resolve(m.result); }
      if (m.method !== 'Debugger.paused' || booted) return;
      booted = true;
      const r = await send('Debugger.evaluateOnCallFrame', {
        callFrameId: m.params.callFrames[0].callFrameId,
        expression: `require(${JSON.stringify(bootstrap)})(${JSON.stringify(base)})`, returnByValue: true,
      });
      if (r.exceptionDetails) throw Error('bootstrap');
      await send('Debugger.resume');
    } catch { failure = 'inspector-bootstrap'; terminate(); }
  });
});
const deadlineMs = process.argv.includes('--manual-shortcut') ? 1800000 : soak ? 960000 : 180000;
const timeout = setTimeout(() => { watchdog = true; terminate(); }, deadlineMs);
const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, deadlineMs + 3000);
const resultPath = path.join(base, 'qa-result.json');
const poll = setInterval(() => { if (fs.existsSync(resultPath)) ws?.close(); }, 100);
child.on('close', (code, signal) => {
  clearTimeout(timeout); clearTimeout(killTimer); clearInterval(poll); ws?.close(); log.end();
  let result = null;
  if (fs.existsSync(resultPath) && fs.statSync(resultPath).size <= 65536) {
    try { result = JSON.parse(fs.readFileSync(resultPath)); } catch { failure = 'invalid-result'; }
  }
  let unchanged = false;
  try { unchanged = snapshot(root) === before; } catch { failure = 'fixture-verification'; }
  let remaining = false;
  try { process.kill(-child.pid, 0); remaining = true; } catch {}
  const passed = code === 0 && signal === null && !failure && !watchdog && !remaining && unchanged
    && result?.packaged === true && result.errors?.length === 0 && result.checks?.length === ((longMode ? 195 : 181) + (resources ? 7 : 0) + (soak ? 4 : 0));
  const report = { passed, code, signal, failure, watchdog, remaining, unchanged,
    durationMs: Date.now() - started, node: process.version, platform: process.platform, arch: process.arch,
    asarSha256: hash(asar), bootstrapSha256: hash(bootstrap), result };
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = passed ? 0 : 1;
});
