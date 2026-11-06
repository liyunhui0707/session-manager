'use strict';
(function () {
const active = new WeakMap();
function showImageLightbox(doc, bytes, info, label, returnFocus) {
  active.get(doc)?.();
  const win = doc.defaultView, dialog = doc.createElement('dialog');
  dialog.className = 'image-lightbox'; dialog.setAttribute('aria-label', `${label} · 大图预览`);
  const toolbar = doc.createElement('div'); toolbar.className = 'image-lightbox-toolbar';
  const title = doc.createElement('span'); title.textContent = `${label} · ${info.width} × ${info.height}`;
  const zoom = doc.createElement('button'); zoom.type = 'button'; zoom.textContent = '原始尺寸'; zoom.setAttribute('aria-pressed', 'false');
  const close = doc.createElement('button'); close.type = 'button'; close.textContent = '关闭';
  const viewport = doc.createElement('div'); viewport.className = 'image-lightbox-viewport';
  const img = doc.createElement('img'); img.alt = label;
  const url = win.URL.createObjectURL(new win.Blob([bytes], { type: info.mime })); img.src = url;
  viewport.append(img); toolbar.append(title, zoom, close); dialog.append(toolbar, viewport);
  let closed = false;
  function dispose() {
    if (closed) return;
    closed = true; dialog.close(); img.removeAttribute('src'); dialog.replaceChildren(); dialog.remove(); win.URL.revokeObjectURL(url);
    if (active.get(doc) === dispose) active.delete(doc);
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  close.addEventListener('click', dispose);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dispose(); });
  dialog.addEventListener('close', dispose);
  img.addEventListener('error', dispose);
  zoom.addEventListener('click', () => {
    const actual = dialog.dataset.actual !== 'true'; dialog.dataset.actual = String(actual);
    zoom.textContent = actual ? '适应窗口' : '原始尺寸'; zoom.setAttribute('aria-pressed', String(actual));
  });
  doc.body.append(dialog); active.set(doc, dispose); dialog.showModal(); close.focus();
  return dispose;
}
const api = { showImageLightbox };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);
})();
