import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const advisoryURL = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const expires = Date.parse('2026-12-18T00:00:00Z');
const high = severity => ['high', 'critical'].includes(severity);

// A dated, exact advisory exception, not a reduced global audit threshold.
// Follow inherited reports to their actual advisories; unknown graph data fails closed.
export function assessAudit(report, lock, now = Date.now()) {
  if (!report?.vulnerabilities || report.error || !report.metadata?.vulnerabilities || !lock?.packages)
    throw Error('Incomplete dependency audit');
  const findings = report.vulnerabilities;
  const blocked = [], accepted = [];
  function leaves(name, seen = new Set()) {
    if (seen.has(name)) return [];
    const item = findings[name];
    if (!item || !Array.isArray(item.via) || !item.via.length) throw Error('Incomplete advisory graph');
    const next = new Set(seen).add(name);
    return item.via.flatMap(v => typeof v === 'string' ? leaves(v, next) :
      v && typeof v.url === 'string' && ['low', 'moderate', 'high', 'critical'].includes(v.severity)
        ? [v] : (() => { throw Error('Unknown advisory shape'); })());
  }
  for (const [name, finding] of Object.entries(findings)) {
    if (!['low', 'moderate', 'high', 'critical'].includes(finding.severity)) throw Error('Unknown severity');
    if (!high(finding.severity)) continue;
    const causes = leaves(name).filter(v => high(v.severity));
    const nodes = finding.nodes;
    const buildOnly = Array.isArray(nodes) && nodes.length > 0 && nodes.every(n => lock.packages[n]?.dev === true);
    const allowed = finding.severity === 'high' && buildOnly && now < expires && causes.length > 0 && causes.every(v =>
      v.url === advisoryURL && v.name === 'picomatch' && v.severity === 'high');
    const affected = findings.picomatch?.nodes;
    const exactVersion = Array.isArray(affected) && affected.length > 0 && affected.every(n =>
      lock.packages[n]?.dev === true && lock.packages[n]?.version === '4.0.7');
    (allowed && exactVersion ? accepted : blocked).push(name);
  }
  return { blocked, accepted, expires: '2026-12-18T00:00:00Z', advisoryURL };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  try {
    if (result.error || ![0, 1].includes(result.status)) throw Error('npm audit did not complete');
    const report = JSON.parse(result.stdout);
    const assessment = assessAudit(report, JSON.parse(fs.readFileSync('package-lock.json', 'utf8')));
    console.log(JSON.stringify({ counts: report.metadata.vulnerabilities, ...assessment }, null, 2));
    if (assessment.accepted.length) console.warn('Known build-only advisory remains open under the dated exception in docs/dependency-audit.md.');
    process.exitCode = assessment.blocked.length ? 1 : 0;
  } catch (error) {
    console.error('Release dependency audit failed:', error.message); process.exitCode = 1;
  }
}
