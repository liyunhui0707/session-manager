const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeFrontmatterScalar,
  resolveSessionTitle,
} = require('../../lib/session-title');

test('frontmatter title decoding preserves YAML-sensitive JSON string content', () => {
  assert.equal(
    decodeFrontmatterScalar('"Release: \\"alpha\\" #1"'),
    'Release: "alpha" #1',
  );
});

test('session title uses an explicit Codex rename before the session id', () => {
  assert.equal(resolveSessionTitle({
    source: 'codex',
    source_custom_title: 'Renamed thread',
    source_session_id: 'session-123',
  }, 'rollout-file'), 'Renamed thread');
});

test('session title uses source_session_id when no explicit rename exists', () => {
  assert.equal(resolveSessionTitle({
    source: 'codex',
    source_custom_title: '   ',
    source_session_id: 'session-123',
  }, 'rollout-file'), 'session-123');
});

test('Codex ignores a stale AI-generated title', () => {
  assert.equal(resolveSessionTitle({
    source: 'codex',
    source_ai_title: 'Automatic first-message title',
    source_session_id: 'session-123',
  }, 'rollout-file'), 'session-123');
});

test('session title preserves existing Claude AI-title behavior', () => {
  assert.equal(resolveSessionTitle({
    source: 'claude',
    source_ai_title: 'Claude title',
    source_session_id: 'session-123',
  }, 'rollout-file'), 'Claude title');
});

test('session title falls back to filename when session metadata is unavailable', () => {
  assert.equal(resolveSessionTitle({}, 'rollout-file'), 'rollout-file');
});
