'use strict';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeFrontmatterScalar(value) {
  const raw = String(value);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      // Preserve the existing permissive behavior for malformed frontmatter.
    }
  }
  return raw.replace(/^['"]|['"]$/g, '');
}

function resolveSessionTitle(frontmatter, fallbackTitle) {
  const metadata = frontmatter || {};
  if (clean(metadata.source).toLowerCase() === 'codex') {
    return clean(metadata.source_custom_title)
      || clean(metadata.source_session_id)
      || fallbackTitle;
  }
  return clean(metadata.source_custom_title)
    || clean(metadata.source_ai_title)
    || clean(metadata.source_session_id)
    || fallbackTitle;
}

module.exports = { decodeFrontmatterScalar, resolveSessionTitle };
