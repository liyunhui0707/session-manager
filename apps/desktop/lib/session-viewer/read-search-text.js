'use strict';

(function () {

const { renderMarkdown } = typeof require !== 'undefined'
  ? require('./read-renderer') : window.SessionViewer;

// Reuse the reader's parsing/drop rules with a text-only document adapter.
// Indexing must not create browser DOM for a deferred large transcript.
function extractReadTextRuns(markdown) {
  return extractTextRuns((document) => renderMarkdown(markdown, { document }));
}

function extractConversationTextRuns(conversation) {
  // Resolve lazily: the existing app loads only the legacy reader scripts.
  const { renderStructuredConversation } = typeof require !== 'undefined'
    ? require('./structured-conversation') : window.SessionViewer;
  return extractTextRuns((document) => renderStructuredConversation(conversation, { document }));
}

function extractTextRuns(render) {
  function element(tag) {
    return {
      tag,
      children: [],
      attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
    };
  }
  const document = {
    createElement: element,
    createDocumentFragment: () => element('#fragment'),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
  const root = render(document);
  const runs = [];
  function collect(node) {
    if (node.attrs?.['data-search-ignore'] === 'true') return;
    let adjacentText = '';
    const flush = () => {
      if (adjacentText) runs.push(adjacentText);
      adjacentText = '';
    };
    for (const child of node.children) {
      if (child.nodeType === 3) adjacentText += child.textContent;
      else {
        flush();
        collect(child);
      }
    }
    flush();
  }
  // Match clearHighlights' adjacent-text coalescing, while keeping element
  // boundaries separate. Arrays avoid artificial separator-character matches.
  collect(root);
  return runs;
}

const api = { extractReadTextRuns, extractConversationTextRuns };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
