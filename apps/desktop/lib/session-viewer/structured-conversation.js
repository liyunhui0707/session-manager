'use strict';

(function () {

const { renderMessageBody } = typeof require !== 'undefined'
  ? require('./read-renderer') : window.SessionViewer;

function renderStructuredConversation(conversation, opts) {
  const invalid = () => new TypeError('structured-conversation: invalid messages');
  if (!conversation || Array.isArray(conversation) || !Array.isArray(conversation.messages)) {
    throw invalid();
  }
  // Validate the entire shape before creating any DOM, including sparse arrays.
  for (const message of conversation.messages) {
    if (!message || Array.isArray(message) || !['user', 'assistant'].includes(message.role)
      || typeof message.text !== 'string') throw invalid();
  }
  const doc = (opts && opts.document) || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('structured-conversation: document is required');
  const fragment = doc.createDocumentFragment();
  const { describeMessage, renderPresentation } = typeof require !== 'undefined'
    ? require('./conversation-presentation') : window.SessionViewer;
  for (const [index, { role, text, continuation }] of conversation.messages.entries()) {
    const section = doc.createElement('section');
    section.setAttribute('class', `read-section ${role}-turn`);
    const heading = doc.createElement('h2');
    heading.appendChild(doc.createTextNode(role === 'user' ? '你' : '助手'));
    section.appendChild(heading);
    const isPart = continuation && Number.isInteger(continuation.number) && Number.isInteger(continuation.total) &&
      continuation.number > 0 && continuation.number <= continuation.total && continuation.total <= 100000;
    if (isPart) {
      const label = doc.createElement('p');
      label.setAttribute('class', 'message-part-label');
      label.setAttribute('data-search-ignore', 'true');
      label.appendChild(doc.createTextNode(`长消息 · 第 ${continuation.number} / ${continuation.total} 段`));
      section.appendChild(label);
    }
    const presentation = describeMessage(text, role);
    section.appendChild(presentation ? renderPresentation(presentation, doc, !!opts?.collapseLongMessages,
      opts?.loadImage && ((image, size) => opts.loadImage(index, image, size)))
      : renderMessageBody(text, { document: doc, role,
        initialFenceMarker: isPart ? continuation.fenceMarker : 0, startsMidLine: isPart && continuation.startsMidLine === true }));
    if (opts && opts.collapseLongMessages && !presentation) {
      const { addMessageDisclosure } = typeof require !== 'undefined'
        ? require('./message-disclosure') : window.SessionViewer;
      addMessageDisclosure(section, text, doc, index, role === 'assistant');
    }
    fragment.appendChild(section);
  }
  return fragment;
}

const api = { renderStructuredConversation };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
