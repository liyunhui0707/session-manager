/* Stage S3 — Read renderer: drop rules for tool blocks, command wrappers,
   system reminders, skill bodies.
   Run focused: node --test test/session-viewer/read-drop-rules.test.js
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

function user(body) {
  return `## User — 2026-01-01T00:00:00.000Z\n\n${body}`;
}
function assistant(body) {
  return `## Assistant — 2026-01-01T00:00:01.000Z\n\n${body}`;
}

function paragraphTexts(frag) {
  return findAllByTag(frag, 'p').map(flattenText);
}

test('### Tool use: <name> block is dropped including its fence', () => {
  const src = `${assistant('intro')}
### Tool use: Bash

\`\`\`json
{ "command": "ls" }
\`\`\`

## Assistant — 2026-01-01T00:00:02.000Z

second turn`;
  const { frag } = render(src);
  const ps = paragraphTexts(frag);
  assert.deepEqual(ps, ['intro', 'second turn']);
  // No Tool-use heading rendered
  const h3s = findAllByTag(frag, 'h3').map(flattenText);
  assert.equal(h3s.includes('Tool use: Bash'), false);
});

test('### Tool result block is dropped', () => {
  const src = `${user('run it')}
### Tool result

\`\`\`
total 0
\`\`\`

## Assistant — 2026-01-01T00:00:02.000Z

ok`;
  const { frag } = render(src);
  const ps = paragraphTexts(frag);
  assert.deepEqual(ps, ['run it', 'ok']);
});

test('### Tool result (error) is dropped', () => {
  const src = `${user('run it')}
### Tool result (error)

\`\`\`
command failed
\`\`\`

## Assistant — 2026-01-01T00:00:02.000Z

ok`;
  const { frag } = render(src);
  const ps = paragraphTexts(frag);
  assert.deepEqual(ps, ['run it', 'ok']);
});

test('tool block ends at next ## heading (role boundary closes the window)', () => {
  const src = `${assistant('first')}
### Tool use: X

dropped paragraph inside tool block

## User — 2026-01-01T00:00:02.000Z

resumed user`;
  const { frag } = render(src);
  const ps = paragraphTexts(frag);
  assert.deepEqual(ps, ['first', 'resumed user']);
});

test('tool block ends at next ### Tool result heading too', () => {
  const src = `${assistant('hi')}
### Tool use: X

input
### Tool result

output

## User — 2026-01-01T00:00:02.000Z

next`;
  const { frag } = render(src);
  // Both tool sections dropped; just 'hi' and 'next' remain.
  const ps = paragraphTexts(frag);
  assert.deepEqual(ps, ['hi', 'next']);
});

test('<command-name>foo</command-name> renders as a user-typed slash paragraph', () => {
  const src = user('<command-name>/foo</command-name>\n<command-message>foo</command-message>\n<command-args></command-args>');
  const { frag } = render(src);
  const ps = findAllByTag(frag, 'p');
  assert.equal(ps.length, 1);
  assert.equal(flattenText(ps[0]), '/foo');
  assert.equal(ps[0].attrs.class, 'user-typed');
});

test('<command-message>…</command-message> is dropped entirely', () => {
  const src = user('<command-name>/x</command-name>\n<command-message>extra plumbing</command-message>\n<command-args></command-args>');
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.equal(text.includes('extra plumbing'), false);
});

test('<command-args>BODY</command-args> body content flows through normal rendering', () => {
  const src = user('<command-name>/x</command-name>\n<command-message>x</command-message>\n<command-args>some user args text</command-args>');
  const { frag } = render(src);
  const ps = findAllByTag(frag, 'p').map(flattenText);
  // One paragraph for the slash command, one for the args body.
  assert.deepEqual(ps, ['/x', 'some user args text']);
});

test('multi-line <command-args>…</command-args> spans correctly', () => {
  const src = user('<command-name>/x</command-name>\n<command-message>x</command-message>\n<command-args>first arg line\nsecond arg line</command-args>');
  const { frag } = render(src);
  const ps = findAllByTag(frag, 'p').map(flattenText);
  // 2 paragraphs: slash + joined args lines
  assert.deepEqual(ps, ['/x', 'first arg line\nsecond arg line']);
});

test('<local-command-stdout>…</local-command-stdout> on one line is dropped', () => {
  const src = user('hello\n<local-command-stdout>noise</local-command-stdout>\nworld');
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.equal(text.includes('noise'), false);
  // Should still contain hello + world (separate paragraphs because the
  // dropped line creates a paragraph boundary indirectly).
  assert.match(text, /hello/);
  assert.match(text, /world/);
});

test('multi-line <local-command-stdout> block is dropped until closing tag', () => {
  const src = user(`hello
<local-command-stdout>
first noise line
second noise line
</local-command-stdout>
world`);
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.equal(text.includes('noise'), false);
  assert.match(text, /hello/);
  assert.match(text, /world/);
});

test('<system-reminder> blocks are dropped', () => {
  const src = user('please do X\n<system-reminder>do not do X</system-reminder>\ndoing X now');
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.equal(text.includes('do not do X'), false);
  assert.match(text, /please do X/);
  assert.match(text, /doing X now/);
});

test('multi-line <system-reminder> is dropped until role boundary', () => {
  // No closing tag inside the block; the next User/Assistant H2 closes it.
  const src = `${user('start')}
<system-reminder>
line a
line b
${assistant('next')}`;
  const { frag } = render(src);
  const ps = paragraphTexts(frag);
  // The unclosed reminder eats everything until the role H2; 'start' renders
  // as a normal user paragraph; 'next' renders as a normal assistant paragraph.
  assert.deepEqual(ps, ['start', 'next']);
});

test('<local-command-caveat> and <local-command-stderr> are also dropped', () => {
  const src = user('hi\n<local-command-caveat>caveat</local-command-caveat>\n<local-command-stderr>stderr</local-command-stderr>\nbye');
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.equal(text.includes('caveat'), false);
  assert.equal(text.includes('stderr'), false);
  assert.match(text, /hi/);
  assert.match(text, /bye/);
});

test('round-7: [Image: source: <path>] lines are dropped from user turns', () => {
  const src = user(
    'maybe you are right\n\n[Image: source: /Users/test/.claude/image-cache/abc/3.png]\n\n[Image: source: /Users/test/.claude/image-cache/abc/4.png]',
  );
  const { frag } = render(src);
  const text = flattenText(frag);
  // The user's actual message survives.
  assert.match(text, /maybe you are right/);
  // The image-source noise is gone.
  assert.ok(!/Image: source:/.test(text), 'image-source line should be dropped');
  assert.ok(!/image-cache/.test(text), 'image-cache path should be dropped');
});

test('round-7: [Image: source: …] in assistant turns is left alone (drop is user-only)', () => {
  // Assistant turns never run the user-line preprocessor; the literal
  // text passes through, matching the existing drop-rule scoping.
  const src = assistant('reply with [Image: source: /tmp/x.png] noted');
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.match(text, /Image: source: \/tmp\/x\.png/);
});

test('round-7: a placeholder line like "[Image #3] [Image #4]" is preserved', () => {
  // The user's typed message uses placeholder labels (NOT "source:" lines).
  // Those must continue to render — only the importer's expanded
  // source-path lines get dropped.
  const src = user('[Image #3] [Image #4] maybe you are right');
  const { frag } = render(src);
  const text = flattenText(frag);
  assert.match(text, /\[Image #3\]/);
  assert.match(text, /\[Image #4\]/);
  assert.match(text, /maybe you are right/);
});

test('drop rules only apply in user turns, not assistant', () => {
  const src = assistant('hi\n<system-reminder>this is shown</system-reminder>\nbye');
  const { frag } = render(src);
  const text = flattenText(frag);
  // In an assistant turn, the renderer does not run the user-line preprocessor;
  // the tag text appears literally in the output.
  assert.match(text, /this is shown/);
});

test('round-3 M2 regression: skill body window closes at next role H2 AND the heading switches sections', () => {
  // Codex round-3 flagged that preprocessUserLine might "swallow" the next
  // role H2 line. In practice, preprocessUserLine sets inSkillBody=false
  // when it sees a role H2 and returns the line unchanged (drop=false), so
  // the main heading parser then creates the new section. This test pins
  // that behavior so a future refactor can't regress it.
  const src = `## User — 2026-01-01T00:00:00.000Z

<command-name>/skill</command-name>
<command-message>skill</command-message>
<command-args>
Base directory for this skill: /tmp

skill body that should be dropped
## Assistant — 2026-01-01T00:00:01.000Z

assistant reply after skill body`;
  const { frag } = render(src);
  // TWO sections, in order, with the right classes.
  assert.equal(frag.children.length, 2);
  assert.equal(frag.children[0].attrs.class, 'read-section user-turn');
  assert.equal(frag.children[1].attrs.class, 'read-section assistant-turn');
  // The skill body content is dropped; /skill + assistant reply remain.
  const ps = findAllByTag(frag, 'p').map(flattenText);
  assert.deepEqual(ps, ['/skill', 'assistant reply after skill body']);
});

test('skill body window: drops from "Base directory for this skill:" to next role H2', () => {
  const src = user(`<command-name>/skill</command-name>
<command-message>skill</command-message>
<command-args>
Base directory for this skill: /some/path

# Skill Heading
body paragraph that should be dropped
</command-args>
real user message after skill body`);
  const { frag } = render(src);
  const ps = paragraphTexts(frag);
  // Only the slash command + the trailing real user message should render
  assert.deepEqual(ps, ['/skill', 'real user message after skill body']);
});

test('pending slash command is flushed before dropped tag', () => {
  // command-name then immediately a system-reminder line.
  // The slash should still render even if the reminder follows.
  const src = user('<command-name>/x</command-name>\n<system-reminder>noise</system-reminder>\nafter');
  const { frag } = render(src);
  const ps = findAllByTag(frag, 'p').map(flattenText);
  // /x renders (flushed when the reminder line tries to drop)
  // 'after' renders as a normal user paragraph
  assert.deepEqual(ps, ['/x', 'after']);
});

test('no unsafe API writes across all drop-rule scenarios', () => {
  const samples = [
    user('<command-name>/x</command-name>\n<command-message>m</command-message>\n<command-args>body</command-args>'),
    user('<local-command-stdout>noise</local-command-stdout>\nclean'),
    assistant('### Tool use: X\n\nstuff\n\n## User — 1\n\nresume'),
  ];
  for (const src of samples) {
    const { doc } = render(src);
    assert.equal(doc.unsafeApiWrites, 0);
  }
});
