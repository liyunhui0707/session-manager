// Guard against eagerly rendering multi-MB transcripts. Pure module:
// exposes only the predicate used by the standalone deferred-load path.
//
// CJS-loadable + window-attached inside an IIFE so the const/function
// declarations don't collide with other browser-script globals
// (matches the IIFE pattern from S3's read-* modules).

'use strict';

(function () {

// Char count threshold (UTF-16 code units, matching String.length).
// Rendering work scales with character count, not encoded bytes.
const LARGE_SESSION_CHARS = 500 * 1024;

function isLargeSession(note) {
  if (!note || typeof note !== 'object') return false;
  if (note.sessionsImport !== true) return false;
  if (typeof note.body !== 'string') return false;
  return note.body.length >= LARGE_SESSION_CHARS;
}

const api = {
  LARGE_SESSION_CHARS,
  isLargeSession,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
