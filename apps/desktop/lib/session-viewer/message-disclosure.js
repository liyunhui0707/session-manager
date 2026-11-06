'use strict';
(function () {
const disclosures = new WeakMap();
const PREVIEW_CHARS = 240;

function previewText(root) {
  let text = '';
  function visit(node) {
    if (text.length > PREVIEW_CHARS) return;
    if (node.nodeType === 3) {
      text += (node.textContent || '').slice(0, PREVIEW_CHARS + 1 - text.length);
      return;
    }
    for (const child of Array.from(node.childNodes || node.children || [])) {
      visit(child);
      if (text.length > PREVIEW_CHARS) break;
    }
    if (/^(P|H[1-6]|LI|PRE|BLOCKQUOTE|TR)$/.test(node.tagName || '')) text += ' ';
  }
  visit(root);
  const truncated = text.length > PREVIEW_CHARS;
  const snippet = text.slice(0, PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, '').replace(/\s+/g, ' ').trim();
  return snippet + (truncated ? '…' : '');
}

function addMessageDisclosure(section, text, doc, index, initiallyExpanded = false) {
  if (text.length < 800 && text.split('\n').length < 12) return;
  const body = doc.createElement('div');
  body.setAttribute('class', 'message-full-body');
  body.setAttribute('id', `codex-message-body-${index}`);
  // Keep the role heading in place. Move the existing body DOM, never reparse it.
  const children = Array.from(section.childNodes || section.children);
  for (const child of children.slice(1)) {
    if (child.getAttribute?.('class') === 'message-part-label') continue;
    section.removeChild(child);
    body.appendChild(child);
  }
  const preview = doc.createElement('p');
  preview.setAttribute('class', 'message-preview');
  preview.setAttribute('data-search-ignore', 'true');
  preview.textContent = previewText(body);
  const button = doc.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute('class', 'message-disclosure');
  button.setAttribute('data-search-ignore', 'true');
  button.setAttribute('aria-controls', body.getAttribute('id'));
  function setExpanded(expanded) {
    body.hidden = !expanded;
    preview.hidden = expanded;
    button.textContent = expanded ? '收起正文' : '展开全文';
    button.setAttribute('aria-expanded', String(expanded));
  }
  button.addEventListener('click', () => setExpanded(body.hidden));
  disclosures.set(section, () => setExpanded(true));
  setExpanded(initiallyExpanded);
  // The control stays above the body so expanding it does not move keyboard focus.
  section.appendChild(button);
  section.appendChild(preview);
  section.appendChild(body);
}

function revealMessageMatch(match) {
  for (let node = match; node; node = node.parentElement || node.parentNode || node.parent) {
    const expand = disclosures.get(node);
    if (expand) { expand(); return; }
  }
}

const api = { addMessageDisclosure, revealMessageMatch };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);
})();
