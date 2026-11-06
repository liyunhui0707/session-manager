import { spawn } from 'node:child_process';

const minimum = {
  tests: 395,
  pass: 395,
  fail: 0,
  cancelled: 0,
  skipped: 0,
  todo: 0,
};
const tailLimit = 512 * 1024;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeOptions = [process.env.NODE_OPTIONS, '--test-reporter=tap']
  .filter(Boolean)
  .join(' ');

let stdoutTail = '';
function appendTail(text) {
  stdoutTail = (stdoutTail + text).slice(-tailLimit);
}

const child = spawn(npmCommand, ['test'], {
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  appendTail(text);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

const outcome = await new Promise((resolve) => {
  child.once('error', (error) => {
    resolve({ code: null, signal: null, spawnError: error });
  });
  child.once('close', (code, signal) => {
    resolve({ code, signal, spawnError: null });
  });
});

if (outcome.spawnError) {
  console.error(`[test-baseline] unable to run npm test: ${outcome.spawnError.message}`);
  process.exit(1);
}
if (outcome.signal) {
  console.error(`[test-baseline] npm test terminated by signal ${outcome.signal}`);
  process.exit(1);
}
if (outcome.code !== 0) {
  console.error(`[test-baseline] npm test exited with code ${outcome.code}`);
  process.exit(outcome.code || 1);
}

function readSummaryCount(label) {
  const pattern = new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm');
  let match = null;
  let current;
  while ((current = pattern.exec(stdoutTail)) !== null) match = current;
  return match ? Number(match[1]) : null;
}

const actual = {
  tests: readSummaryCount('tests'),
  pass: readSummaryCount('pass'),
  fail: readSummaryCount('fail'),
  cancelled: readSummaryCount('cancelled'),
  skipped: readSummaryCount('skipped'),
  todo: readSummaryCount('todo'),
};
const missing = Object.entries(actual)
  .filter(([, value]) => value === null)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(`[test-baseline] TAP summary missing: ${missing.join(', ')}`);
  console.error('[test-baseline] final captured TAP output:');
  console.error(stdoutTail);
  process.exit(1);
}

const failures = [];
if (actual.tests < minimum.tests) {
  failures.push(`tests ${actual.tests} < ${minimum.tests}`);
}
if (actual.pass < minimum.pass) {
  failures.push(`pass ${actual.pass} < ${minimum.pass}`);
}
if (actual.fail !== minimum.fail) {
  failures.push(`fail ${actual.fail} != ${minimum.fail}`);
}
if (actual.cancelled !== minimum.cancelled) {
  failures.push(`cancelled ${actual.cancelled} != ${minimum.cancelled}`);
}
if (actual.skipped > minimum.skipped) {
  failures.push(`skipped ${actual.skipped} > ${minimum.skipped}`);
}
if (actual.todo !== minimum.todo) {
  failures.push(`todo ${actual.todo} != ${minimum.todo}`);
}

if (failures.length > 0) {
  console.error(`[test-baseline] regression: ${failures.join('; ')}`);
  process.exit(1);
}

console.log(
  `[test-baseline] passed: tests=${actual.tests}, pass=${actual.pass}, ` +
  `fail=${actual.fail}, cancelled=${actual.cancelled}, skipped=${actual.skipped}, ` +
  `todo=${actual.todo}`,
);
