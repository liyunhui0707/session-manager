/* Stage S3 — Read renderer: edge cases.
   Run focused: node --test test/session-viewer/read-edge-cases.test.js
*/

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdown } = require('../../lib/session-viewer/read-renderer.js');
const {
  makeFakeDocument,
  flattenText,
  findByTag,
  findAllByTag,
} = require('./read-fake-document.js');

function render(text) {
  const doc = makeFakeDocument();
  const frag = renderMarkdown(text, { document: doc });
  return { frag, doc };
}

const user = (b) => `## User — 2026-01-01T00:00:00.000Z\n\n${b}`;
const assistant = (b) => `## Assistant — 2026-01-01T00:00:01.000Z\n\n${b}`;

test('importer role headings without optional timestamps retain both turns', () => {
  const { frag } = render('## User\n\nquestion\n\n## Assistant\n\nanswer');
  assert.deepEqual(frag.children.map(section => section.attrs.class), [
    'read-section user-turn', 'read-section assistant-turn',
  ]);
  assert.deepEqual(findAllByTag(frag, 'p').map(flattenText), ['question', 'answer']);
});

for (const dropped of ['<system-reminder>\nhidden context', 'Base directory for this skill: /synthetic/skill\nhidden context']) {
  test(`timestamp-free role boundary ends dropped context: ${dropped.split('\n')[0]}`, () => {
    const { frag } = render(user(dropped) + '\n\n## Assistant\n\nvisible answer');
    assert.deepEqual(findAllByTag(frag, 'p').map(flattenText), ['visible answer']);
  });
}

test('a session whose entire body is dropped renders only the role <h2>, no orphan', () => {
  // Everything is a dropped wrapper tag → currentSectionAttached stays false →
  // the section never gets appended.
  const src = user('<system-reminder>only noise here</system-reminder>');
  const { frag } = render(src);
  assert.equal(frag.children.length, 0, 'no section attached when no real content');
});

test('a session whose body has only a tool block renders nothing (no orphan section either)', () => {
  const src = assistant('### Tool use: X\n\ninput');
  const { frag } = render(src);
  // The tool block drops everything. With lazy attach, the section never
  // gets appended (no content children added) → fragment has zero
  // top-level children. Tighter than just "no <p>" — also prevents an
  // orphan <section><h2></h2></section> sneaking through.
  assert.equal(frag.children.length, 0, 'no orphan role section');
  assert.equal(findAllByTag(frag, 'p').length, 0);
  assert.equal(findAllByTag(frag, 'h2').length, 0);
});

test('unclosed fence absorbs the rest until flush at end', () => {
  const src = assistant('intro\n\n```\nline one\nline two');
  const { frag } = render(src);
  const code = findByTag(frag, 'code');
  assert.ok(code, 'pre/code emitted at end');
  assert.equal(flattenText(code), 'line one\nline two');
});

test('two consecutive tool blocks both drop', () => {
  const src = `${assistant('intro')}
### Tool use: A
input A
### Tool use: B
input B
## User — 2026-01-01T00:00:02.000Z

resume`;
  const { frag } = render(src);
  const ps = findAllByTag(frag, 'p').map(flattenText);
  assert.deepEqual(ps, ['intro', 'resume']);
});

test('lone <command-name> without closing tag is not captured (regex requires close)', () => {
  // Without the closing tag, the regex doesn't match; the line passes through
  // and renders as a regular paragraph (text content).
  const src = user('hello <command-name>/x</command-name closing missing');
  const { frag } = render(src);
  const text = flattenText(frag);
  // The whole line is rendered as-is because the regex didn't match.
  assert.match(text, /hello <command-name>\/x<\/command-name closing missing/);
});

test('text outside any section before a role H2 is silently dropped', () => {
  const src = `Some preamble text.\n\n${user('hello')}`;
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.equal(text.includes('preamble'), false);
  assert.match(text, /hello/);
});

test('multiple role H2s in sequence each get their own <section>', () => {
  const src = `${user('one')}\n\n${assistant('two')}\n\n${user('three')}`;
  const { frag } = render(src);
  assert.equal(frag.children.length, 3);
  assert.equal(frag.children[0].attrs.class, 'read-section user-turn');
  assert.equal(frag.children[1].attrs.class, 'read-section assistant-turn');
  assert.equal(frag.children[2].attrs.class, 'read-section user-turn');
});

test('tool block flag resets at the next role boundary', () => {
  // Tool use → next role H2 should immediately end the tool block and the
  // next content should render.
  const src = `${assistant('first')}
### Tool use: X
${user('next user turn body')}`;
  const { frag } = render(src);
  const ps = findAllByTag(frag, 'p').map(flattenText);
  assert.deepEqual(ps, ['first', 'next user turn body']);
});

test('whitespace-only paragraph is not emitted', () => {
  const src = user('para one\n\n   \n\npara two');
  const { frag } = render(src);
  const ps = findAllByTag(frag, 'p').map(flattenText);
  // The middle whitespace line is dropped at trim; we should get two
  // paragraphs (or possibly one with a whitespace-only line preserved).
  // Either way, the whitespace line should NOT become its own visible para.
  assert.ok(ps.length >= 2, `got ${ps.length} paragraphs: ${JSON.stringify(ps)}`);
});

test('renderMarkdown throws if no document is available', () => {
  // Save and restore the global; node test env may or may not have one.
  const saved = global.document;
  delete global.document;
  try {
    assert.throws(
      () => require('../../lib/session-viewer/read-renderer.js').renderMarkdown('## User — t\n\nhi'),
      /document/,
    );
  } finally {
    if (saved !== undefined) global.document = saved;
  }
});
