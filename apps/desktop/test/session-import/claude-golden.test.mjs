import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_NOW,
  mkTempVault,
  cleanupTempVault,
  copyFixtureWithPinnedMtime,
  expectedFromBaseline,
} from './helpers.mjs';
import { CLAUDE_SCENARIOS } from './scenarios.mjs';
import { runClaudeImport } from '../../tools/session-import/import-claude.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const PROJECT = 'test-project';

function countLF(b) {
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) n += 1;
  return n;
}

for (const scen of CLAUDE_SCENARIOS) {
  test(`claude: ${scen.name} bytes equal expectedFromBaseline(claude)`, async (t) => {
    const tmpRaw = mkTempVault();
    const tmp = fs.realpathSync(tmpRaw);
    t.after(() => cleanupTempVault(tmpRaw));

    const srcRoot = path.join(tmp, 'source');
    const outBase = path.join(tmp, 'output');
    const fixtureSrc = path.join(
      FIXTURES,
      'claude',
      scen.name,
      PROJECT,
      scen.uuid + '.jsonl',
    );
    const fixtureDest = path.join(srcRoot, PROJECT, scen.uuid + '.jsonl');
    copyFixtureWithPinnedMtime(fixtureSrc, fixtureDest);

    const result = await runClaudeImport({
      sourceRoot: srcRoot,
      outputBase: outBase,
      maxBytes: 52428800,
      now: FIXED_NOW,
    });
    assert.equal(result.imported, 1, `${scen.name}: one file imported`);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);

    const outPath = path.join(outBase, PROJECT, scen.uuid + '.md');
    const actual = fs.readFileSync(outPath);
    const baseline = fs.readFileSync(
      path.join(FIXTURES, 'upstream-baseline', `claude-${scen.name}.md`),
    );
    const expected = expectedFromBaseline(baseline, 'claude');
    assert.equal(
      Buffer.compare(actual, expected),
      0,
      `${scen.name}: bytes must equal baseline + inserted 'source: claude' line`,
    );
    assert.equal(
      countLF(actual),
      countLF(baseline) + 1,
      `${scen.name}: exactly one extra LF`,
    );
  });
}

test('claude: basic scenario is idempotent under repeated runs', async (t) => {
  const tmpRaw = mkTempVault();
  const tmp = fs.realpathSync(tmpRaw);
  t.after(() => cleanupTempVault(tmpRaw));

  const uuid = CLAUDE_SCENARIOS[0].uuid;
  const srcRoot = path.join(tmp, 'source');
  const outBase = path.join(tmp, 'output');
  const fixtureSrc = path.join(
    FIXTURES,
    'claude',
    'basic',
    PROJECT,
    uuid + '.jsonl',
  );
  const fixtureDest = path.join(srcRoot, PROJECT, uuid + '.jsonl');
  copyFixtureWithPinnedMtime(fixtureSrc, fixtureDest);

  const args = {
    sourceRoot: srcRoot,
    outputBase: outBase,
    maxBytes: 52428800,
    now: FIXED_NOW,
  };
  await runClaudeImport(args);
  const outPath = path.join(outBase, PROJECT, uuid + '.md');
  const first = fs.readFileSync(outPath);
  await runClaudeImport(args);
  const second = fs.readFileSync(outPath);
  assert.equal(Buffer.compare(first, second), 0, 'idempotent byte-equal');
});
