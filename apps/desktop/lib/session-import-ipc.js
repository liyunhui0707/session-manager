// Standalone session-manager refresh IPC handler.
// Thin wrapper around the S1 importers at apps/desktop/tools/session-import/
// (which are .mjs). Importers are loaded via dynamic import() on first use
// in production; in tests they're injected through register(ipc, {importers}).
// Single-flight, per-agent outputBase, typed-reason failure response
// ({ok:false, reason:'no-library'|'in-progress'|'platform-unsupported'|
// 'import-error'}; never throws across the IPC boundary; err.message is
// dropped here so absolute paths from the importers can't leak to the
// renderer — see test/session-viewer/refresh-ipc.test.js T1 for the
// sanitization invariant).

'use strict';

const path = require('node:path');
const os = require('node:os');

const CHANNEL = 'sessionViewer:import';
const MAX_BYTES = 52428800;

const CLAUDE_ESM_REL =
  '../tools/session-import/import-claude.mjs';
const CODEX_ESM_REL =
  '../tools/session-import/import-codex.mjs';

// Predicate matches the well-known importer emit string verbatim. Source:
//   apps/desktop/tools/session-import/import-claude.mjs:204
//   apps/desktop/tools/session-import/import-codex.mjs:59
//   apps/desktop/tools/session-import/lib/safe-read.mjs:17
// If any of those throw sites is reworded, T2 in refresh-ipc.test.js must
// be updated alongside this prefix.
const O_NOFOLLOW_UNSUPPORTED_PREFIX =
  'symlink-safe reads unsupported on this platform';

function isNoFollowUnsupportedError(err) {
  return !!(
    err &&
    typeof err.message === 'string' &&
    err.message.startsWith(O_NOFOLLOW_UNSUPPORTED_PREFIX)
  );
}

function reasonForRejection(reason) {
  if (isNoFollowUnsupportedError(reason)) return 'platform-unsupported';
  return 'import-error';
}

let inFlight = false;

async function defaultImporters() {
  const [claudeMod, codexMod] = await Promise.all([
    import(new URL(CLAUDE_ESM_REL, `file://${__filename}`).href),
    import(new URL(CODEX_ESM_REL, `file://${__filename}`).href),
  ]);
  return {
    runClaudeImport: claudeMod.runClaudeImport,
    runCodexImport: codexMod.runCodexImport,
  };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function agentResult(settled) {
  if (settled.status === 'rejected') {
    return { ok: false, reason: reasonForRejection(settled.reason) };
  }
  const summary = settled.value;
  if (!summary || !['imported', 'skipped', 'errors'].every(
    (key) => Number.isSafeInteger(summary[key]) && summary[key] >= 0,
  )) return { ok: false, reason: 'import-error' };
  // Allowlist the response: importer outputs and arbitrary notes contain paths.
  const { imported, skipped, errors } = summary;
  return {
    ok: errors === 0,
    ...(errors > 0 ? { reason: 'import-error' } : {}),
    imported, skipped, errors,
    ...(summary.note === 'no-source' ? { note: 'no-source' } : {}),
  };
}

async function runImports({ libraryPath, importers }) {
  const sourceClaude = path.join(os.homedir(), '.claude', 'projects');
  const sourceCodex = path.join(os.homedir(), '.codex', 'sessions');
  const outputClaude = path.join(libraryPath, 'claude-code');
  const outputCodex = path.join(libraryPath, 'codex');
  const now = new Date();
  // allSettled (not Promise.all) so the single-flight lock stays held
  // until both importers finish, even if one rejects. Otherwise a
  // pending importer could still be writing when a second Refresh starts.
  const [claudeRes, codexRes] = await Promise.allSettled([
    Promise.resolve().then(() => importers.runClaudeImport({
      sourceRoot: sourceClaude,
      outputBase: outputClaude,
      maxBytes: MAX_BYTES,
      now,
    })),
    Promise.resolve().then(() => importers.runCodexImport({
      sourceRoot: sourceCodex,
      outputBase: outputCodex,
      maxBytes: MAX_BYTES,
      now,
    })),
  ]);
  const claude = agentResult(claudeRes);
  const codex = agentResult(codexRes);
  const failed = [claude, codex].find((result) => !result.ok);
  return { ok: !failed, ...(failed ? { reason: failed.reason } : {}), claude, codex };
}

function register(ipc, options) {
  const importers = (options && options.importers) || null;
  const getLibraryPath = options && options.getLibraryPath;
  if (typeof getLibraryPath !== 'function') {
    throw new Error('session-import-ipc: getLibraryPath is required');
  }
  ipc.handle(CHANNEL, async () => {
    if (options.canImport && !options.canImport()) {
      return { ok: false, reason: 'read-only-source' };
    }
    const libraryPath = await getLibraryPath();
    if (!isNonEmptyString(libraryPath)) {
      return { ok: false, reason: 'no-library' };
    }
    if (inFlight) {
      return { ok: false, reason: 'in-progress' };
    }
    inFlight = true;
    try {
      const eff = importers || (await defaultImporters());
      return await runImports({ libraryPath, importers: eff });
    } catch (err) {
      // runImports itself returns reason-as-value; this catch is for the
      // dynamic-import path (defaultImporters()) failing.
      return { ok: false, reason: reasonForRejection(err) };
    } finally {
      inFlight = false;
    }
  });
}

module.exports = { register, CHANNEL };
