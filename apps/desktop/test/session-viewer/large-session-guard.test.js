/* Standalone large-session protection tests.
   Run focused: node --test test/session-viewer/large-session-guard.test.js */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const MODULE_REL = '../../lib/session-viewer/large-session-guard.js';

function load() {
  delete require.cache[require.resolve(MODULE_REL)];
  return require(MODULE_REL);
}

// ── isLargeSession ────────────────────────────────────────────────────────────

test('T-S3.5-1: isLargeSession rejects null / undefined / non-objects', () => {
  const { isLargeSession } = load();
  for (const bad of [null, undefined, 0, '', 'string', 42, false, true]) {
    assert.equal(isLargeSession(bad), false, `bad input: ${JSON.stringify(bad)}`);
  }
});

test('T-S3.5-1b: isLargeSession rejects {} (no sessionsImport, no body)', () => {
  const { isLargeSession } = load();
  assert.equal(isLargeSession({}), false);
});

test('T-S3.5-2: short body returns false (under threshold)', () => {
  const { isLargeSession } = load();
  assert.equal(
    isLargeSession({ sessionsImport: true, body: 'hello world' }),
    false,
  );
});

test('T-S3.5-3: non-session note with huge body is not considered a transcript', () => {
  const { isLargeSession, LARGE_SESSION_CHARS } = load();
  const note = {
    sessionsImport: false,
    body: 'X'.repeat(LARGE_SESSION_CHARS + 1),
  };
  assert.equal(isLargeSession(note), false);
});

test('T-S3.5-4: exactly at threshold (>=) returns true', () => {
  const { isLargeSession, LARGE_SESSION_CHARS } = load();
  const note = {
    sessionsImport: true,
    body: 'X'.repeat(LARGE_SESSION_CHARS),
  };
  assert.equal(isLargeSession(note), true);
});

test('T-S3.5-5: one char under threshold returns false', () => {
  const { isLargeSession, LARGE_SESSION_CHARS } = load();
  const note = {
    sessionsImport: true,
    body: 'X'.repeat(LARGE_SESSION_CHARS - 1),
  };
  assert.equal(isLargeSession(note), false);
});

test('T-S3.5-6: non-string body returns false', () => {
  const { isLargeSession } = load();
  for (const bad of [42, null, undefined, [], {}, true]) {
    assert.equal(
      isLargeSession({ sessionsImport: true, body: bad }),
      false,
      `bad body: ${JSON.stringify(bad)}`,
    );
  }
});

test('T-S3.5-6a: multi-byte chars — threshold is char count (String.length), not encoded bytes', () => {
  const { isLargeSession, LARGE_SESSION_CHARS } = load();
  // Chinese char takes 3 UTF-8 bytes but is 1 char (UTF-16 code unit).
  // The threshold operates on String.length, which is UTF-16 code units.
  // A string of LARGE_SESSION_CHARS Chinese chars IS considered large.
  const note = {
    sessionsImport: true,
    body: '中'.repeat(LARGE_SESSION_CHARS),
  };
  assert.equal(isLargeSession(note), true);
  // And one char under is NOT.
  const under = {
    sessionsImport: true,
    body: '中'.repeat(LARGE_SESSION_CHARS - 1),
  };
  assert.equal(isLargeSession(under), false);
});

test('LARGE_SESSION_CHARS constant is 500 * 1024', () => {
  const { LARGE_SESSION_CHARS } = load();
  assert.equal(LARGE_SESSION_CHARS, 500 * 1024);
});

test('module exposes only the standalone transcript guard API', () => {
  const api = load();
  const { isLargeSession, LARGE_SESSION_CHARS } = api;
  assert.deepEqual(Object.keys(api).sort(), ['LARGE_SESSION_CHARS', 'isLargeSession']);
  assert.equal(typeof isLargeSession, 'function');
  assert.equal(typeof LARGE_SESSION_CHARS, 'number');
});
