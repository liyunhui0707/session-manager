// Stage S3 — Read-mode Markdown renderer for AI session transcripts.
// Shared safe body rendering with separate legacy-transcript/message entry points.
// Untrusted input — render only the importer's Markdown subset via
// document.createElement / createTextNode. NEVER innerHTML (including for
// clearing — callers must use a removeChild loop).
//
// CJS-loadable + window.SessionViewer.renderMarkdown attachment so both
// the test harness and the browser renderer use the same code.

'use strict';

(function () {

const {
  appendInline,
  leadingBacktickRun,
  splitCells,
  isTableSeparator,
} = (typeof require !== 'undefined'
  ? require('./read-inline.js')
  : (typeof window !== 'undefined' && window.SessionViewer && window.SessionViewer._readInline) || {});

const { preprocessUserLine } = (typeof require !== 'undefined'
  ? require('./read-user-preprocess.js')
  : (typeof window !== 'undefined' && window.SessionViewer && window.SessionViewer._readUserPreprocess) || {});

function renderMarkdown(text, opts) {
  return render(text, opts, null);
}

function renderMessageBody(text, opts) {
  if (typeof text !== 'string' || !opts || !['user', 'assistant'].includes(opts.role)) {
    throw new TypeError('renderMessageBody: invalid message');
  }
  return render(text, opts, opts.role);
}

function render(text, opts, messageRole) {
  const doc = (opts && opts.document) || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('renderMarkdown: document is required');
  const fragment = doc.createDocumentFragment();
  const lines = String(text == null ? '' : text).split('\n');

  // A structured body already has an external role/section. Its headings and
  // wrapper-looking text are content, never transcript control markers.
  let currentSection = messageRole ? fragment : null;
  let currentRole = messageRole;
  let inToolBlock = false;
  let fenceMarker = messageRole && Number.isSafeInteger(opts?.initialFenceMarker) &&
    opts.initialFenceMarker >= 3 && opts.initialFenceMarker <= 2 * 1024 * 1024 ? opts.initialFenceMarker : 0;
  let inFence = fenceMarker > 0;
  let firstLine = true;
  let fenceLines = [];
  let paraLines = [];
  let pendingSlashCommand = null;
  let inSlashArgs = false;
  let inDropTag = null;
  let currentSectionAttached = !!messageRole;
  let inSkillBody = false;

  function attachSection() {
    if (currentSection && !currentSectionAttached) {
      fragment.appendChild(currentSection);
      currentSectionAttached = true;
    }
  }

  function emitPendingSlash() {
    if (pendingSlashCommand && currentSection && currentRole === 'user') {
      const p = doc.createElement('p');
      p.setAttribute('class', 'user-typed');
      p.appendChild(doc.createTextNode(pendingSlashCommand));
      attachSection();
      currentSection.appendChild(p);
    }
    pendingSlashCommand = null;
  }

  function flushPara() {
    emitPendingSlash();
    if (paraLines.length === 0 || !currentSection || inToolBlock) {
      paraLines = [];
      return;
    }
    if (paraLines.every((l) => /^[-*+]\s+/.test(l))) {
      renderList(paraLines, 'ul', /^[-*+]\s+/);
      paraLines = [];
      return;
    }
    if (paraLines.every((l) => /^\d+\.\s+/.test(l))) {
      renderList(paraLines, 'ol', /^\d+\.\s+/);
      paraLines = [];
      return;
    }
    // Stage 6.11: if a non-list prefix is followed by list-marker lines
    // (no blank line in between), split the block into a paragraph for
    // the prefix and a list for the suffix. Without this, "Header text:\n
    // - item one\n- item two" would collapse into a single <p> joined by
    // newlines, which the browser renders as one continuous line.
    const ulStart = paraLines.findIndex((l) => /^[-*+]\s+/.test(l));
    if (ulStart > 0 && paraLines.slice(ulStart).every((l) => /^[-*+]\s+/.test(l))) {
      const prefix = paraLines.slice(0, ulStart);
      const listItems = paraLines.slice(ulStart);
      paraLines = prefix;
      flushPara();
      paraLines = listItems;
      flushPara();
      return;
    }
    const olStart = paraLines.findIndex((l) => /^\d+\.\s+/.test(l));
    if (olStart > 0 && paraLines.slice(olStart).every((l) => /^\d+\.\s+/.test(l))) {
      const prefix = paraLines.slice(0, olStart);
      const listItems = paraLines.slice(olStart);
      paraLines = prefix;
      flushPara();
      paraLines = listItems;
      flushPara();
      return;
    }
    // One level of nesting: the first line is a column-0 list marker,
    // and every subsequent line is either a list marker (any indent) or
    // an indented lazy continuation of the previous item. At least one
    // line must be indented — otherwise the column-0 fast paths above
    // would have matched. Lets Q8-shaped checklists render as a real
    // nested <ul>/<ol> tree, and Q4-shaped items keep their wrapped
    // continuation text (`  1. line one\n     line two`) on the same
    // <li> instead of collapsing into a single fallback <p>.
    if (
      paraLines.length > 0 &&
      /^(?:[-*+]|\d+\.)\s+/.test(paraLines[0]) &&
      paraLines.every((l) => /^\s*(?:[-*+]|\d+\.)\s+/.test(l) || /^\s+\S/.test(l)) &&
      paraLines.some((l) => /^\s+/.test(l))
    ) {
      renderNestedList(paraLines);
      paraLines = [];
      return;
    }
    if (paraLines.length >= 2 && /^\s*\|.*\|\s*$/.test(paraLines[0]) && isTableSeparator(paraLines[0], paraLines[1])) {
      let tableEnd = 2;
      while (tableEnd < paraLines.length && /^\s*\|.*\|\s*$/.test(paraLines[tableEnd])) tableEnd += 1;
      renderTable(paraLines.slice(0, tableEnd));
      const tail = paraLines.slice(tableEnd);
      paraLines = [];
      if (tail.length > 0) {
        paraLines = tail;
        flushPara();
      }
      return;
    }
    const p = doc.createElement('p');
    if (currentRole === 'user') p.setAttribute('class', 'user-typed');
    appendInline(p, paraLines.join('\n'), doc);
    attachSection();
    currentSection.appendChild(p);
    paraLines = [];
  }

  function renderList(items, tagName, markerRegex) {
    attachSection();
    const kids = currentSection.children;
    const last = kids.length > 0 ? kids[kids.length - 1] : null;
    const lastTag = last && (last.tag || (last.tagName && last.tagName.toLowerCase()));
    let list;
    if (lastTag === tagName) {
      list = last;
    } else {
      list = doc.createElement(tagName);
      currentSection.appendChild(list);
    }
    for (const raw of items) {
      const li = doc.createElement('li');
      appendInline(li, raw.replace(markerRegex, ''), doc);
      list.appendChild(li);
    }
  }

  // One-level nested list. Top-level type comes from the first column-0
  // line's marker; deeper indents (any indent > 0) become a nested
  // <ul>/<ol> (matching the indented marker's kind) attached to the
  // most recent top-level <li>. Does not merge with a preceding list —
  // the column-0 fast paths handle that for pure top-level blocks.
  function renderNestedList(items) {
    attachSection();
    const markerRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
    let topType = 'ul';
    for (const raw of items) {
      const m = markerRe.exec(raw);
      if (m && m[1].length === 0) {
        topType = /\d+\./.test(m[2]) ? 'ol' : 'ul';
        break;
      }
    }
    const list = doc.createElement(topType);
    let currentTopLi = null;
    let nested = null;
    let nestedType = null;
    let lastItem = null; // most recent <li> at any level, for continuation lines
    for (const raw of items) {
      const m = markerRe.exec(raw);
      if (!m) {
        // Indented lazy continuation. Append to the most recent <li>
        // with a single space separator so the wrapped line joins the
        // primary text instead of fragmenting into a new item.
        if (lastItem !== null) {
          appendInline(lastItem, ' ' + raw.replace(/^\s+/, ''), doc);
        }
        continue;
      }
      const indent = m[1].length;
      const isOl = /\d+\./.test(m[2]);
      const text = m[3];
      if (indent === 0 || currentTopLi === null) {
        const li = doc.createElement('li');
        appendInline(li, text, doc);
        list.appendChild(li);
        currentTopLi = li;
        nested = null;
        nestedType = null;
        lastItem = li;
      } else {
        const want = isOl ? 'ol' : 'ul';
        if (!nested || nestedType !== want) {
          nested = doc.createElement(want);
          nestedType = want;
          currentTopLi.appendChild(nested);
        }
        const nli = doc.createElement('li');
        appendInline(nli, text, doc);
        nested.appendChild(nli);
        lastItem = nli;
      }
    }
    currentSection.appendChild(list);
  }

  function renderTable(rows) {
    const table = doc.createElement('table');
    const thead = doc.createElement('thead');
    const headTr = doc.createElement('tr');
    for (const cell of splitCells(rows[0])) {
      const th = doc.createElement('th');
      appendInline(th, cell, doc);
      headTr.appendChild(th);
    }
    thead.appendChild(headTr);
    table.appendChild(thead);
    if (rows.length > 2) {
      const tbody = doc.createElement('tbody');
      for (let r = 2; r < rows.length; r += 1) {
        const tr = doc.createElement('tr');
        for (const cell of splitCells(rows[r])) {
          const td = doc.createElement('td');
          appendInline(td, cell, doc);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    attachSection();
    // Stage 6.11: wrap the table in a horizontally-scrollable div. Without
    // this wrapper, `table-layout: auto` squeezes narrow columns below
    // their longest word and the browser falls back to mid-word breaks
    // ("Severity" → "Sev / erit / y") even with overflow-wrap: break-word
    // on cells. The wrapper provides the visual containment so the table
    // itself can render at its natural width and only scrolls horizontally
    // within its own region when wider than the viewport.
    const tableWrapper = doc.createElement('div');
    tableWrapper.setAttribute('class', 'table-scroller');
    tableWrapper.appendChild(table);
    currentSection.appendChild(tableWrapper);
  }

  function flushFence() {
    if (!currentSection || inToolBlock) {
      fenceLines = [];
      return;
    }
    const pre = doc.createElement('pre');
    if (currentRole === 'user') pre.setAttribute('class', 'user-typed');
    const code = doc.createElement('code');
    code.appendChild(doc.createTextNode(fenceLines.join('\n')));
    pre.appendChild(code);
    attachSection();
    currentSection.appendChild(pre);
    fenceLines = [];
  }

  for (const rawLine of lines) {
    let line = rawLine;
    const continuedLine = firstLine && messageRole && opts?.startsMidLine === true;
    firstLine = false;
    if (continuedLine) {
      (inFence ? fenceLines : paraLines).push(line); continue;
    }
    if (inFence) {
      const run = leadingBacktickRun(line);
      if (run >= fenceMarker && line.slice(run).trim() === '') {
        flushFence();
        inFence = false;
        fenceMarker = 0;
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    if (!messageRole && currentRole === 'user' && !inToolBlock) {
      const preState = { inDropTag, inSlashArgs, inSkillBody };
      const res = preprocessUserLine(line, preState);
      inDropTag = preState.inDropTag;
      inSlashArgs = preState.inSlashArgs;
      inSkillBody = preState.inSkillBody;
      if (res.emitSlash) emitPendingSlash();
      if (res.captureSlash !== undefined) pendingSlashCommand = res.captureSlash;
      if (res.drop) continue;
      line = res.line;
    }

    const h1Match = /^#\s+(.+)$/.exec(line);
    if (h1Match && currentSection && !inToolBlock) {
      flushPara();
      attachSection();
      const h1 = doc.createElement('h1');
      appendInline(h1, h1Match[1], doc);
      currentSection.appendChild(h1);
      continue;
    }

    const headingMatch = /^##\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushPara();
      inToolBlock = false;
      const headingText = headingMatch[1];
      const role = messageRole ? null : /^User(?: —|$)/.test(headingText)
        ? 'user-turn'
        : /^Assistant(?: —|$)/.test(headingText)
          ? 'assistant-turn'
          : null;
      if (role) {
        inSlashArgs = false;
        inDropTag = null;
        inSkillBody = false;
        const section = doc.createElement('section');
        section.setAttribute('class', `read-section ${role}`);
        const h2 = doc.createElement('h2');
        appendInline(h2, headingText, doc);
        section.appendChild(h2);
        currentSection = section;
        currentRole = role === 'user-turn' ? 'user' : 'assistant';
        currentSectionAttached = false;
      } else if (currentSection) {
        attachSection();
        const h2 = doc.createElement('h2');
        appendInline(h2, headingText, doc);
        currentSection.appendChild(h2);
      }
      continue;
    }

    const h3Match = /^###\s+(.+)$/.exec(line);
    if (h3Match) {
      flushPara();
      const h3Text = h3Match[1];
      const isToolH3 =
        h3Text.startsWith('Tool use') || h3Text.startsWith('Tool result');
      if (!messageRole && isToolH3) {
        inToolBlock = true;
        continue;
      }
      inToolBlock = false;
      if (!currentSection) continue;
      const h3 = doc.createElement('h3');
      appendInline(h3, h3Text, doc);
      attachSection();
      currentSection.appendChild(h3);
      continue;
    }

    const openRun = leadingBacktickRun(line);
    if (openRun >= 3) {
      flushPara();
      if (!currentSection) {
        inFence = true;
        fenceMarker = openRun;
        fenceLines = [];
        continue;
      }
      inFence = true;
      fenceMarker = openRun;
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      continue;
    }

    if (!currentSection) continue;
    paraLines.push(line);
  }

  if (inFence) flushFence();
  flushPara();

  return fragment;
}

const api = { renderMarkdown, renderMessageBody };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
