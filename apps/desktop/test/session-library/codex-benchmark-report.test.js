'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../../tools/benchmark-codex-report.mjs');
const LIMIT = 157286400;

function sample(combinedBytes = 60 * 1024 * 1024) {
  return {
    baselineRssBytes: 20 * 1024 * 1024,
    sampledPeakRssBytes: 30 * 1024 * 1024,
    parentHighWaterBytes: combinedBytes - 1024 * 1024,
    retainedImmediateRssBytes: 30 * 1024 * 1024,
    retainedIdleRssBytes: 29 * 1024 * 1024,
    helperPeakRssBytes: 1024 * 1024,
    combinedBytes, scanMs: 12,
  };
}

test('memory units convert KiB exactly and reject invalid or overflowing measurements', async () => {
  const { kibToBytes } = await modulePromise;
  assert.equal(kibToBytes(153600), LIMIT);
  for (const input of [undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => kibToBytes(input));
  }
});

test('absolute budget accepts its exact boundary and rejects one byte more without baseline subtraction', async () => {
  const { summarizeScans } = await modulePromise;
  assert.equal(summarizeScans(Array.from({ length: 10 }, () => sample(LIMIT)), 10000).memory, 'PASS');
  const rows = Array.from({ length: 10 }, () => sample());
  rows[0] = sample(LIMIT + 1);
  const result = summarizeScans(rows, 10000);
  assert.equal(result.memory, 'FAIL');
  assert.equal(result.reproducedBreach, false);
  rows[5] = sample(LIMIT + 1);
  assert.equal(summarizeScans(rows, 10000).reproducedBreach, true);
});

test('second batch is triggered strictly above 142.5 MiB or 20 percent spread', async () => {
  const { needsSecondBatch } = await modulePromise;
  assert.equal(needsSecondBatch(Array.from({ length: 5 }, () => sample(149422080))), false);
  assert.equal(needsSecondBatch(Array.from({ length: 5 }, () => sample(149422081))), true);
  assert.equal(needsSecondBatch([50, 50, 50, 50, 60].map(n => sample(n * 1024 * 1024))), false);
  assert.equal(needsSecondBatch([50, 50, 50, 50, 61].map(n => sample(n * 1024 * 1024))), true);
  assert.throws(() => needsSecondBatch([sample()]));
});

test('incomplete batches cannot pass and a later passing batch cannot erase an earlier breach', async () => {
  const { summarizeScans } = await modulePromise;
  assert.equal(summarizeScans([sample()], 100).validity, 'INCONCLUSIVE');
  const first = Array.from({ length: 5 }, () => sample(LIMIT + 1));
  assert.equal(summarizeScans(first, 10000).validity, 'INCONCLUSIVE');
  const all = [...first, ...Array.from({ length: 5 }, () => sample())];
  const result = summarizeScans(all, 10000);
  assert.equal(result.validity, 'VALID');
  assert.equal(result.memory, 'FAIL');
  assert.equal(result.combined.maximum, LIMIT + 1);
  assert.equal(result.samples, 10);
  assert.equal('p95' in result.combined, false);
});

test('reports require complete consistent finite metrics, exact run identity and no extra path fields', async () => {
  const { validateWorkerReport } = await modulePromise;
  const request = { runId: 'run-1', mode: 'scan', count: 100 };
  const report = { version: 1, ...request, pid: 123, entries: 100, uniqueEntries: 100, metrics: sample() };
  assert.deepEqual(validateWorkerReport(report, request), report);
  const invalid = [
    { ...report, runId: 'other' }, { ...report, entries: 99 },
    { ...report, sourcePath: '/private/source' },
    { ...report, metrics: { ...sample(), helperPeakRssBytes: 0 } },
    { ...report, metrics: { ...sample(), combinedBytes: 1 } },
    { ...report, metrics: { ...sample(), parentHighWaterBytes: 1 } },
    { ...report, metrics: { ...sample(), scanMs: NaN } },
    { ...report, metrics: { ...sample(), path: '/private/source' } },
  ];
  for (const value of invalid) assert.throws(() => validateWorkerReport(value, request));
  const missing = structuredClone(report);
  delete missing.metrics.retainedIdleRssBytes;
  assert.throws(() => validateWorkerReport(missing, request));
});

test('cancellation reports require observed rejection and helper closure, each within the timing budget', async () => {
  const { validateWorkerReport, summarizeCancellation } = await modulePromise;
  const request = { runId: 'cancel-1', mode: 'cancel', count: 100 };
  const report = { version: 1, ...request, pid: 123, rejectionMs: 1, closeMs: 20, reason: 'SCAN_CANCELLED' };
  validateWorkerReport(report, request);
  assert.equal(summarizeCancellation(Array(5).fill(report)).verdict, 'PASS');
  assert.equal(summarizeCancellation([...Array(4).fill(report), { ...report, closeMs: 251 }]).verdict, 'FAIL');
  assert.equal(summarizeCancellation([report]).verdict, 'INCONCLUSIVE');
  assert.throws(() => validateWorkerReport({ ...report, closeMs: null }, request));
  assert.throws(() => validateWorkerReport({ ...report, reason: 'completed' }, request));
});
