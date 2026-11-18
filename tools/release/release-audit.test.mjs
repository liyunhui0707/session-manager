import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAudit } from '../../apps/desktop/tools/release-audit.mjs';
const url = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
function fixture() {
  return { report: { metadata: { vulnerabilities: { high: 2 } }, vulnerabilities: {
    picomatch: { severity: 'high', nodes: ['node_modules/picomatch'], via: [{ name: 'picomatch', severity: 'high', url }] },
    builder: { severity: 'high', nodes: ['node_modules/builder'], via: ['picomatch'] },
  } }, lock: { packages: {
    'node_modules/picomatch': { version: '4.0.7', dev: true }, 'node_modules/builder': { version: '1.0.0', dev: true },
  } } };
}
const now = Date.parse('2026-11-18T00:00:00Z');
test('only the reviewed build advisory and inherited reports qualify before expiry', () => {
  const { report, lock } = fixture();
  assert.deepEqual(assessAudit(report, lock, now).blocked, []);
  assert.equal(assessAudit(report, lock, now).accepted.length, 2);
  assert.equal(assessAudit(report, lock, Date.parse('2026-12-18T00:00:00Z')).blocked.length, 2);
});
test('new advisories, critical severity, runtime dependencies and version drift block', () => {
  for (const mutate of [
    ({ report }) => report.vulnerabilities.picomatch.via[0].url += '-different',
    ({ report }) => report.vulnerabilities.picomatch.via[0].severity = 'critical',
    ({ lock }) => lock.packages['node_modules/picomatch'].dev = false,
    ({ lock }) => lock.packages['node_modules/picomatch'].version = '4.0.8',
  ]) {
    const input = fixture(); mutate(input);
    assert.equal(assessAudit(input.report, input.lock, now).blocked.length, 2);
  }
});
test('mixed inherited reports cannot hide a second high advisory', () => {
  const { report, lock } = fixture();
  report.vulnerabilities.builder.via.push({ name: 'another', severity: 'high', url: 'https://example.invalid/new' });
  assert.deepEqual(assessAudit(report, lock, now).blocked, ['builder']);
});
test('malformed reports and missing dependency edges fail closed', () => {
  assert.throws(() => assessAudit({}, {}, now));
  const { report, lock } = fixture();
  report.vulnerabilities.builder.via = ['missing'];
  assert.throws(() => assessAudit(report, lock, now));
});
