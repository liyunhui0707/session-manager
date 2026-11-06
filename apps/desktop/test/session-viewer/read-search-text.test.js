'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('../../lib/session-viewer/read-renderer');
const { applyInFileSearch } = require('../../lib/session-viewer/search-dom');
const { searchIndex } = require('../../lib/session-viewer/search-index');
const { makeFakeDocument } = require('./read-fake-document');

const cases = [
  ['hidden tools and empty roles', '## User\n\nvisible\n\n## Assistant\n\n### Tool result\nhiddenneedle', ['visible', 'hiddenneedle', 'Assistant']],
  ['user wrappers', '## User\n<system-reminder>hidden</system-reminder>\n<command-name>/sample</command-name>\n<command-args>typed</command-args>', ['hidden', '/sample', 'typed']],
  ['formatting', '## User\nleft**right** and _italic_ and `code`', ['leftright', 'left**right', 'right', 'italic', 'code']],
  ['nested lists and continuation', '## User\n- parent\n  - nested\n    continued\n- end', ['nested continued', 'parentnested', 'continued']],
  ['table cells', '## Assistant\n| first | second |\n| --- | --- |\n| value | value |', ['firstsecond', 'value']],
  ['headings and fences', '## User\n# **heading**\n```\n## Assistant\nverbatim\n```', ['heading', 'Assistant', 'verbatim']],
  ['control characters', '## User\nleft**right**\n\nactual\u0001text', ['left\u0001right', 'actual\u0001text']],
];

for (const [name, body, queries] of cases) {
  test(`search index counts equal reader highlights: ${name}`, () => {
    const { extractReadTextRuns } = require('../../lib/session-viewer/read-search-text');
    const runs = extractReadTextRuns(body);
    for (const query of queries) {
      const doc = makeFakeDocument();
      const mount = doc.createElement('article');
      mount.appendChild(renderMarkdown(body, { document: doc }));
      const state = {};
      applyInFileSearch(mount, query, state, doc);
      const results = searchIndex([{ id: 'synthetic', textContent: runs }], query);
      assert.equal(results[0]?.matchCount || 0, state.matches.length, query);
    }
  });
}
