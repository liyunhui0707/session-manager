// Stage S4 — DOM walk + highlighting for in-file search.
//
// Verbatim port of Local-Web-Server/public/search-utils.js lines 10-153
// + applyInFileSearch + setActiveMatch. The cross-session index +
// scoring helpers live in search-index.js (kept under the 300-line cap).
//
// Invariants:
//   - No `innerHTML` writes. `<mark>` elements are inserted via
//     createElement + createTextNode through the injected `document`.
//   - Cross-node matches (text broken by inline elements) are NOT
//     highlighted — substring scan operates per text node. v1 limit.
//
// IIFE-wrapped + dual CJS/window export (matches the S3 read-* modules).

'use strict';

(function () {

function replaceChildren(parent, newChildren) {
  if (Array.isArray(parent.children)) {
    parent.children.length = 0;
    for (const c of newChildren) parent.children.push(c);
    return;
  }
  parent.replaceChildren(...newChildren);
}

function listAllChildren(node) {
  if (!node) return [];
  if (node.childNodes && typeof node.childNodes.length === 'number') {
    return Array.from(node.childNodes);
  }
  return node.children || [];
}

function wrapMatchesInTextNode(textNode, query, doc) {
  if (!query) return [textNode];
  const text = textNode.textContent || '';
  if (text.length === 0) return [textNode];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const found = haystack.indexOf(needle, i);
    if (found === -1) {
      if (i < text.length) {
        out.push(doc.createTextNode(text.slice(i)));
      }
      break;
    }
    if (found > i) {
      out.push(doc.createTextNode(text.slice(i, found)));
    }
    const mark = doc.createElement('mark');
    mark.appendChild(doc.createTextNode(text.slice(found, found + needle.length)));
    out.push(mark);
    i = found + needle.length;
  }
  if (out.length === 1 && out[0].nodeType === 3 && out[0].textContent === text) {
    return [textNode];
  }
  return out.length === 0 ? [textNode] : out;
}

function isMarkEl(child) {
  if (!child) return false;
  if (child.tag === 'mark') return true;
  if (typeof child.tagName === 'string' && child.tagName.toLowerCase() === 'mark') return true;
  return false;
}

function walkAndHighlight(rootEl, query, doc, marks) {
  if (!marks) marks = [];
  if (!query) return marks;
  if (!rootEl) return marks;
  if (rootEl.getAttribute && rootEl.getAttribute('data-search-ignore') === 'true') return marks;
  const kids = listAllChildren(rootEl);
  if (kids.length === 0) return marks;
  const rebuilt = [];
  for (const child of kids) {
    if (child.nodeType === 3) {
      const parts = wrapMatchesInTextNode(child, query, doc);
      for (const p of parts) {
        rebuilt.push(p);
        if (isMarkEl(p)) marks.push(p);
      }
    } else if (isMarkEl(child)) {
      rebuilt.push(child);
    } else {
      walkAndHighlight(child, query, doc, marks);
      rebuilt.push(child);
    }
  }
  replaceChildren(rootEl, rebuilt);
  return marks;
}

function coalesceTextChildren(parent, doc) {
  if (!parent) return;
  const kids = listAllChildren(parent);
  if (kids.length === 0) return;
  const rebuilt = [];
  let buf = '';
  const flushBuf = () => {
    if (buf.length > 0) {
      rebuilt.push(doc.createTextNode(buf));
      buf = '';
    }
  };
  for (const child of kids) {
    if (child && child.nodeType === 3) {
      buf += child.textContent || '';
    } else {
      flushBuf();
      rebuilt.push(child);
    }
  }
  flushBuf();
  replaceChildren(parent, rebuilt);
}

function textOfNode(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  if (typeof node.textContent === 'string' && (!node.tag && !node.tagName)) {
    return node.textContent;
  }
  let out = '';
  for (const c of listAllChildren(node)) {
    out += textOfNode(c);
  }
  return out;
}

function clearHighlights(rootEl, doc) {
  if (!rootEl) return;
  if (rootEl.getAttribute && rootEl.getAttribute('data-search-ignore') === 'true') return;
  const kids = listAllChildren(rootEl);
  if (kids.length === 0) return;
  const rebuilt = [];
  for (const child of kids) {
    if (isMarkEl(child)) {
      rebuilt.push(doc.createTextNode(textOfNode(child)));
    } else if (child && child.nodeType !== 3) {
      clearHighlights(child, doc);
      rebuilt.push(child);
    } else {
      rebuilt.push(child);
    }
  }
  replaceChildren(rootEl, rebuilt);
  coalesceTextChildren(rootEl, doc);
}

function setActiveMatch(matches, oldIdx, newIdx) {
  if (!matches || matches.length === 0) return;
  if (oldIdx >= 0 && oldIdx < matches.length) {
    matches[oldIdx].setAttribute('class', 'mark');
  }
  if (newIdx >= 0 && newIdx < matches.length) {
    matches[newIdx].setAttribute('class', 'mark mark--active');
  }
}

function applyInFileSearch(container, query, state, doc) {
  if (!container) {
    state.matches = [];
    state.currentMatchIndex = 0;
    return;
  }
  clearHighlights(container, doc);
  if (!query) {
    state.matches = [];
    state.currentMatchIndex = 0;
    return;
  }
  const marks = walkAndHighlight(container, query, doc);
  state.matches = marks;
  state.currentMatchIndex = 0;
  if (marks.length > 0) {
    marks[0].setAttribute('class', 'mark mark--active');
  }
}

const api = {
  replaceChildren,
  wrapMatchesInTextNode,
  walkAndHighlight,
  clearHighlights,
  setActiveMatch,
  applyInFileSearch,
  textOfNode,
  coalesceTextChildren,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
