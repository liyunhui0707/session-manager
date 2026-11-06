'use strict';
(function () {
// Only exact transport envelopes at a user-message boundary are recognized.
// Unknown formats remain readable verbatim; quoted examples are never controls.
function describeMessage(text, role, includeImagePaths = false) {
  if (role !== 'user') return null;
  const reply = text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
  if (reply) {
    try {
      const items = JSON.parse(reply[1]);
      if (Array.isArray(items) && items.length > 0 && items.length <= 32 && items.every(item =>
        item && !Array.isArray(item) && typeof item.question === 'string' && typeof item.answer === 'string' &&
        Object.keys(item).every(key => ['question', 'answer', 'questionItemId'].includes(key)))) {
        return { kind: 'questions', items };
      }
    } catch { /* Fall through to literal Markdown. */ }
    return null;
  }
  let rest = text, images = [];
  const envelope = /^\s*<image name=\[Image #(\d{1,4})\] path="([^"\r\n]{1,4096})">\s*<\/image>/;
  while (images.length < 16) {
    const match = rest.match(envelope);
    if (!match) break;
    images.push({ number: match[1], ...(includeImagePaths ? { path: match[2] } : {}) });
    rest = rest.slice(match[0].length);
  }
  return images.length ? { kind: 'images', images, text: rest.trim() } : null;
}

function renderPresentation(presentation, doc, interactive = false, loadImage) {
  const { renderMessageBody } = typeof require !== 'undefined' ? require('./read-renderer') : window.SessionViewer;
  function node(tag, text, className) {
    const el = doc.createElement(tag);
    if (className) el.setAttribute('class', className);
    if (text !== undefined) el.appendChild(doc.createTextNode(text));
    return el;
  }
  const root = node('div', undefined, 'conversation-presentation');
  if (presentation.kind === 'questions') {
    for (const item of presentation.items) {
      const card = node('div', undefined, 'question-reply');
      card.appendChild(node('p', '助手提问', 'protocol-label'));
      card.appendChild(node('blockquote', item.question));
      card.appendChild(node('p', '我的回答', 'protocol-label'));
      card.appendChild(node('p', item.answer || '尚未回答', 'question-answer'));
      root.appendChild(card);
    }
  } else {
    for (const [imageIndex, item] of presentation.images.entries()) {
      const card = node('figure', undefined, 'attachment-card');
      card.appendChild(node('figcaption', `图片 ${item.number}`));
      const controls = node('div', undefined, 'attachment-controls');
      controls.setAttribute('data-search-ignore', 'true');
      controls.appendChild(node('p', loadImage ? '在阅读时关联本地原图，也可手动选择。' : '选择本地原图，在这里预览。', 'attachment-note'));
      if (interactive) {
        const { attachLocalImagePicker } = typeof require !== 'undefined' ? require('./local-image-preview') : window.SessionViewer;
        attachLocalImagePicker(controls, doc, `图片 ${item.number}`, loadImage && (size => loadImage(imageIndex, size)));
      }
      card.appendChild(controls);
      root.appendChild(card);
    }
    root.appendChild(renderMessageBody(presentation.text, { document: doc, role: 'user' }));
  }
  return root;
}
const api = { describeMessage, renderPresentation };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);
})();
