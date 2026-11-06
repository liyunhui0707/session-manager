'use strict';
(function () {
function createOperationStatus(status, retryButton, readMount) {
  let retry = null, busy = false, retrying = false, isError = false;
  function sync() {
    if (status.dataset) status.dataset.kind = busy ? 'busy' : isError ? 'error' : 'status';
    readMount?.setAttribute?.('aria-busy', String(busy));
    if (retryButton) { retryButton.hidden = !retry; retryButton.disabled = busy || retrying; }
  }
  function set(message, error = false, action = null) {
    status.textContent = message || ''; isError = error;
    retry = typeof action === 'function' ? action : null; sync();
  }
  retryButton?.addEventListener('click', async () => {
    if (!retry || busy || retrying) return;
    const action = retry; retrying = true; sync();
    try { await action(); }
    catch { if (retry === action) set('重试未完成，当前内容已保留。请稍后再试。', true, action); }
    finally { retrying = false; sync(); }
  });
  sync();
  return { set, busy(value) { busy = !!value; sync(); } };
}
const api = { createOperationStatus };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);
})();
