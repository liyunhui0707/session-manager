'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDocument, flattenText, findAllByTag } = require('./read-fake-document');
const { renderStructuredConversation } = require('../../lib/session-viewer/structured-conversation');
const { extractConversationTextRuns } = require('../../lib/session-viewer/read-search-text');
const { applyInFileSearch } = require('../../lib/session-viewer/search-dom');
const wrap = (data) => `<send_user_message_question_reply>\n${JSON.stringify(data)}\n</send_user_message_question_reply>`;
const input = (text, role = 'user') => ({ messages: [{ role, text }] });
const render = (text, role = 'user') => renderStructuredConversation(input(text, role), { document: makeFakeDocument() });

test('question replies show questions and answers, hiding transport IDs and JSON syntax', () => {
  const text = wrap([{ question: '选择哪个方向？', answer: '简洁精致', questionItemId: 'private-routing-id' },
    { question: '第二个问题', answer: '第二个答案' }]);
  const root = render(text);
  assert.equal(findAllByTag(root, 'blockquote').length, 2);
  const visible = flattenText(root);
  for (const expected of ['选择哪个方向？', '简洁精致', '第二个问题', '第二个答案']) assert.ok(visible.includes(expected));
  for (const hidden of ['questionItemId', 'private-routing-id', '<send_user_message_question_reply>', '"answer":']) assert.ok(!visible.includes(hidden));
});

test('empty answers remain explicitly unanswered and HTML stays literal', () => {
  const root = render(wrap([{ question: '<img src=x onerror=attack()>', answer: '' }]));
  assert.match(flattenText(root), /尚未回答/);
  assert.match(flattenText(root), /<img/);
  assert.equal(findAllByTag(root, 'img').length, 0);
});

test('unknown, malformed, quoted and assistant protocol text is preserved', () => {
  const valid = wrap([{ question: 'q', answer: 'a' }]);
  for (const text of [wrap([]), wrap([{ question: 'q', answer: 1 }]), wrap([{ question: 'q', answer: 'a', future: 'keep' }]),
    '<send_user_message_question_reply>{broken}</send_user_message_question_reply>', 'explanation\n' + valid, '```\n' + valid + '\n```']) {
    assert.match(flattenText(render(text)), /send_user_message_question_reply/);
  }
  assert.match(flattenText(render(valid, 'assistant')), /send_user_message_question_reply/);
});

test('image envelopes become attachment cards without creating automatic image loads', () => {
  const text = '<image name=[Image #1] path="/private/tmp/synthetic.png">\n</image>' +
    '<image name=[Image #2] path="https://example.invalid/tracker.png">\n</image>\n[Image #1] 请看这两张图 [Image #2]';
  const root = render(text);
  assert.equal(findAllByTag(root, 'figure').length, 2);
  assert.match(flattenText(root), /请看这两张图/);
  assert.equal(findAllByTag(root, 'img').length, 0);
  assert.ok(!flattenText(root).includes('<image name='));
  assert.ok(!flattenText(root).includes('https://'));
  assert.ok(!flattenText(root).includes('/private/tmp'));
});

test('image syntax in code or nonempty/unknown envelopes is preserved', () => {
  for (const text of ['```\n<image name=[Image #1] path="/tmp/x.png"></image>\n```',
    '<image name=[Image #1] path="/tmp/x.png">important text</image>',
    '<image name=[Image #1] path="/tmp/x.png" extra="future"></image>']) {
    assert.equal(findAllByTag(render(text), 'figure').length, 0);
    assert.match(flattenText(render(text)), /<image/);
  }
});

test('question/attachment text indexes match on-screen search and omit protocol metadata', () => {
  for (const text of [wrap([{ question: '方向 needle', answer: 'needle 简洁', questionItemId: 'routingneedle' }]),
    '<image name=[Image #1] path="/tmp/pathneedle.png"></image>\n[Image #1] needle']) {
    const conversation = input(text), runs = extractConversationTextRuns(conversation);
    const doc = makeFakeDocument(), root = doc.createElement('article');
    root.appendChild(renderStructuredConversation(conversation, { document: doc }));
    for (const query of ['needle', 'routingneedle', 'pathneedle', '图片']) {
      const state = {};
      applyInFileSearch(root, query, state, doc);
      const count = runs.reduce((n, run) => n + run.split(query).length - 1, 0);
      assert.equal(state.matches.length, count, query);
      if (query.endsWith('needle') && query !== 'needle') assert.equal(count, 0);
    }
  }
});
