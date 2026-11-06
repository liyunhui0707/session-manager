import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FIXED_NOW,
  mkTempVault,
  cleanupTempVault,
  copyFixtureWithPinnedMtime,
  expectedFromBaseline,
} from './helpers.mjs';
import { CODEX_SCENARIOS } from './scenarios.mjs';
import { runCodexImport } from '../../tools/session-import/import-codex.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const DAY_PATH = '2026/01/01';

function countLF(b) {
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) n += 1;
  return n;
}

function rolloutBase(uuid) {
  return `rollout-2026-01-01T00-00-00-${uuid}`;
}

function writeThreadIndex(tmp, entries) {
  const indexPath = path.join(tmp, 'fake-codex/session_index.jsonl');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(
    indexPath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}

async function importBasicFixture(t, { indexEntries = [] } = {}) {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));

  const scen = CODEX_SCENARIOS[0];
  const srcRoot = path.join(tmp, 'fake-codex/sessions');
  const outBase = path.join(tmp, 'output');
  const base = rolloutBase(scen.uuid);
  copyFixtureWithPinnedMtime(
    path.join(FIXTURES, 'codex', scen.name, DAY_PATH, base + '.jsonl'),
    path.join(srcRoot, DAY_PATH, base + '.jsonl'),
  );
  if (indexEntries.length > 0) writeThreadIndex(tmp, indexEntries);

  const run = () => runCodexImport({
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  });
  const outPath = path.join(outBase, DAY_PATH, base + '.md');
  return { scen, tmp, run, outPath };
}

for (const scen of CODEX_SCENARIOS) {
  test(`codex: ${scen.name} bytes equal expectedFromBaseline(codex)`, async (t) => {
    const tmpRaw = mkTempVault();
    const tmp = fs.realpathSync(tmpRaw);
    t.after(() => cleanupTempVault(tmpRaw));

    const srcRoot = path.join(tmp, 'fake-codex/sessions');
    const outBase = path.join(tmp, 'output');
    const base = rolloutBase(scen.uuid);
    const fixtureSrc = path.join(
      FIXTURES,
      'codex',
      scen.name,
      DAY_PATH,
      base + '.jsonl',
    );
    const fixtureDest = path.join(srcRoot, DAY_PATH, base + '.jsonl');
    copyFixtureWithPinnedMtime(fixtureSrc, fixtureDest);

    const result = await runCodexImport({
      sourceRoot: srcRoot,
      outputBase: outBase,
      maxBytes: 52428800,
      now: FIXED_NOW,
    });
    assert.equal(result.imported, 1, `${scen.name}: one file imported`);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);

    const outPath = path.join(outBase, DAY_PATH, base + '.md');
    const actual = fs.readFileSync(outPath);
    const baseline = fs.readFileSync(
      path.join(FIXTURES, 'upstream-baseline', `codex-${scen.name}.md`),
    );
    const expected = expectedFromBaseline(baseline, 'codex');
    assert.equal(
      Buffer.compare(actual, expected),
      0,
      `${scen.name}: bytes must equal baseline + inserted 'source: codex' line`,
    );
    assert.equal(
      countLF(actual),
      countLF(baseline) + 1,
      `${scen.name}: exactly one extra LF`,
    );
  });
}

test('codex: explicit Thread name is written as source_custom_title with JSON-safe encoding', async (t) => {
  const title = 'Release: "alpha" #1';
  const fixture = await importBasicFixture(t, {
    indexEntries: [{ id: CODEX_SCENARIOS[0].uuid, thread_name: title }],
  });

  const result = await fixture.run();
  assert.equal(result.imported, 1);
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.match(output, new RegExp(`^source_custom_title: ${JSON.stringify(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('codex: missing or blank Thread name emits no custom title', async (t) => {
  const fixture = await importBasicFixture(t, {
    indexEntries: [{ id: CODEX_SCENARIOS[0].uuid, thread_name: '   ' }],
  });

  await fixture.run();
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.doesNotMatch(output, /^source_custom_title:/m);
  assert.match(output, new RegExp(`^source_session_id: "${fixture.scen.uuid}"$`, 'm'));
});

test('codex: re-import replaces an earlier Thread name with the latest rename', async (t) => {
  const fixture = await importBasicFixture(t, {
    indexEntries: [{ id: CODEX_SCENARIOS[0].uuid, thread_name: 'Old name' }],
  });

  await fixture.run();
  writeThreadIndex(fixture.tmp, [
    { id: fixture.scen.uuid, thread_name: 'Old name' },
    { id: fixture.scen.uuid, thread_name: 'New name' },
  ]);
  await fixture.run();

  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.match(output, /^source_custom_title: "New name"$/m);
  assert.doesNotMatch(output, /^source_custom_title: "Old name"$/m);
});

test('codex: a later blank Thread name clears an earlier rename', async (t) => {
  const fixture = await importBasicFixture(t, {
    indexEntries: [
      { id: CODEX_SCENARIOS[0].uuid, thread_name: 'Old name' },
      { id: CODEX_SCENARIOS[0].uuid, thread_name: '   ' },
    ],
  });

  await fixture.run();
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.doesNotMatch(output, /^source_custom_title:/m);
  assert.match(output, new RegExp(`^source_session_id: "${fixture.scen.uuid}"$`, 'm'));
});

test('codex: an incomplete later index record preserves an earlier rename', async (t) => {
  const fixture = await importBasicFixture(t, {
    indexEntries: [
      { id: CODEX_SCENARIOS[0].uuid, thread_name: 'Keep this name' },
      { id: CODEX_SCENARIOS[0].uuid },
    ],
  });

  await fixture.run();
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.match(output, /^source_custom_title: "Keep this name"$/m);
});

test('codex: unavailable optional Thread-name index does not block import', async (t) => {
  const fixture = await importBasicFixture(t);
  fs.mkdirSync(path.join(fixture.tmp, 'fake-codex/session_index.jsonl'));

  const result = await fixture.run();
  assert.equal(result.imported, 1);
  assert.equal(result.errors, 0);
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.doesNotMatch(output, /^source_custom_title:/m);
  assert.match(output, new RegExp(`^source_session_id: "${fixture.scen.uuid}"$`, 'm'));
});

test('codex: oversized optional Thread-name index is ignored', async (t) => {
  const fixture = await importBasicFixture(t);
  const indexPath = path.join(fixture.tmp, 'fake-codex/session_index.jsonl');
  const entry = JSON.stringify({
    id: fixture.scen.uuid,
    thread_name: 'Must not be read',
  }) + '\n';
  fs.writeFileSync(indexPath, entry + ' '.repeat(1024 * 1024));

  const result = await fixture.run();
  assert.equal(result.imported, 1);
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.doesNotMatch(output, /^source_custom_title:/m);
});

test('codex: symlinked optional Thread-name index is ignored', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows: symlink creation requires admin');
    return;
  }
  const fixture = await importBasicFixture(t);
  const target = path.join(fixture.tmp, 'thread-index-target.jsonl');
  writeThreadIndex(fixture.tmp, [{
    id: fixture.scen.uuid,
    thread_name: 'Must not be followed',
  }]);
  const indexPath = path.join(fixture.tmp, 'fake-codex/session_index.jsonl');
  fs.renameSync(indexPath, target);
  fs.symlinkSync(target, indexPath);

  const result = await fixture.run();
  assert.equal(result.imported, 1);
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.doesNotMatch(output, /^source_custom_title:/m);
});

test('codex: FIFO optional Thread-name index does not block import', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows does not provide mkfifo');
    return;
  }
  const fixture = await importBasicFixture(t);
  const indexPath = path.join(fixture.tmp, 'fake-codex/session_index.jsonl');
  execFileSync('mkfifo', [indexPath]);

  const result = await fixture.run();
  assert.equal(result.imported, 1);
  assert.equal(result.errors, 0);
  const output = fs.readFileSync(fixture.outPath, 'utf8');
  assert.doesNotMatch(output, /^source_custom_title:/m);
  assert.match(output, new RegExp(`^source_session_id: "${fixture.scen.uuid}"$`, 'm'));
});
