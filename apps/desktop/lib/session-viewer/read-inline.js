// Stage S3 — Inline tokenizer for the Read-mode renderer.
// Verbatim port of Local-Web-Server/public/read-renderer.js lines 324-475
// (the inline helpers + table-cell splitter + table-separator detector).
// CJS-loadable so the Node test harness can require() it; also attaches
// to window.SessionViewer in the renderer.

'use strict';

(function () {

function appendInline(parent, text, document) {
  for (const tok of tokenizeInline(text)) {
    if (tok.type === 'text') {
      parent.appendChild(document.createTextNode(tok.value));
    } else if (tok.type === 'strong' || tok.type === 'em') {
      const el = document.createElement(tok.type);
      appendInline(el, tok.value, document);
      parent.appendChild(el);
    } else {
      const el = document.createElement(tok.type);
      el.appendChild(document.createTextNode(tok.value));
      parent.appendChild(el);
    }
  }
}

function tokenizeInline(text) {
  const tokens = [];
  let i = 0;
  let buf = '';
  function flush() {
    if (buf) {
      tokens.push({ type: 'text', value: buf });
      buf = '';
    }
  }
  while (i < text.length) {
    const ch = text[i];
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const marker = ch + ch;
      const close = text.indexOf(marker, i + 2);
      if (close !== -1) {
        flush();
        tokens.push({ type: 'strong', value: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) {
        buf += text.slice(i);
        i = text.length;
        continue;
      }
      flush();
      tokens.push({ type: 'code', value: text.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (ch === '_') {
      const prev = i > 0 ? text[i - 1] : null;
      const next = i + 1 < text.length ? text[i + 1] : null;
      if (canOpenItalic(prev, next)) {
        let j = i + 2;
        let foundClose = -1;
        while (j < text.length) {
          const k = text.indexOf('_', j);
          if (k === -1) break;
          const cprev = text[k - 1];
          const cnext = k + 1 < text.length ? text[k + 1] : null;
          if (canCloseItalic(cprev, cnext)) {
            foundClose = k;
            break;
          }
          j = k + 1;
        }
        if (foundClose !== -1) {
          flush();
          tokens.push({ type: 'em', value: text.slice(i + 1, foundClose) });
          i = foundClose + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return tokens;
}

function canOpenItalic(prev, next) {
  if (next == null || next === '_' || /\s/.test(next)) return false;
  if (prev != null && /[A-Za-z0-9]/.test(prev)) return false;
  return true;
}

function canCloseItalic(prev, next) {
  if (prev == null || prev === '_' || /\s/.test(prev)) return false;
  if (next != null && /[A-Za-z0-9]/.test(next)) return false;
  return true;
}

function leadingBacktickRun(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 96) n += 1;
  return n;
}

function splitCells(row) {
  // Tokenizer over a single table row that respects:
  //   - inline code spans, including multi-backtick runs (e.g. ``a|b``):
  //     a code span opens with a run of N backticks and closes with another
  //     run of EXACTLY N. Pipes inside the span do NOT split cells.
  //   - backslash-escaped pipes \| — preserved verbatim in the cell.
  // An unclosed code span absorbs the rest of the row as one cell.
  const trimmed = row.trim().replace(/^\||\|$/g, '');
  const cells = [];
  let buf = '';
  let openRun = 0;
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (openRun === 0 && ch === '\\' && trimmed[i + 1] === '|') {
      buf += '\\|';
      i += 2;
      continue;
    }
    if (ch === '`') {
      let runLen = 0;
      while (trimmed[i + runLen] === '`') runLen += 1;
      buf += '`'.repeat(runLen);
      if (openRun === 0) {
        openRun = runLen;
      } else if (runLen === openRun) {
        openRun = 0;
      }
      i += runLen;
      continue;
    }
    if (ch === '|' && openRun === 0) {
      cells.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  cells.push(buf.trim());
  return cells;
}

function isTableSeparator(headerRow, sepRow) {
  const headerCols = splitCells(headerRow).length;
  const sepCells = splitCells(sepRow);
  if (sepCells.length !== headerCols) return false;
  return sepCells.every((c) => /^:?-+:?$/.test(c));
}

const api = {
  appendInline,
  tokenizeInline,
  canOpenItalic,
  canCloseItalic,
  leadingBacktickRun,
  splitCells,
  isTableSeparator,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, {
    _readInline: api,
  });
}

})();
