'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  decodeFrontmatterScalar,
  resolveSessionTitle,
} = require('./session-title');

const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const AGENT_DIRECTORIES = Object.freeze([
  { directory: 'claude-code', agent: 'claude' },
  { directory: 'codex', agent: 'codex' },
]);

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function parseFrontmatter(markdown) {
  const normalized = String(markdown).replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: normalized };
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const frontmatter = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (key) frontmatter[key] = decodeFrontmatterScalar(rawValue);
  }
  return {
    frontmatter,
    body: normalized.slice(end + 5).replace(/^\n/, ''),
  };
}

function messageCount(body) {
  const matches = String(body).match(/^## (?:User|Assistant)\b/gm);
  return matches ? matches.length : 0;
}

async function readSessionFile(filePath, canonicalAgentRoot) {
  const safeRead = await import(
    '../tools/session-import/lib/safe-read.mjs'
  );
  return safeRead.readSessionFileSafe(
    filePath,
    canonicalAgentRoot,
    MAX_SESSION_BYTES,
  );
}

function isRejectedFile(error) {
  // Only known filesystem/safe-reader failures are recoverable per file.
  // Unsupported safe reads, resource exhaustion, and programming errors
  // still reject the load. Never pass error messages or paths to the UI.
  return !!error && (
    ['OVER_CAP', 'ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EISDIR', 'EIO'].includes(error.code)
    || ['path is not a regular file', 'file resolves outside source root',
      'post-open identity mismatch'].includes(error.message)
  );
}

async function collectAgentSessions({
  canonicalLibraryRoot,
  directory,
  agent,
}) {
  const requestedAgentRoot = path.join(canonicalLibraryRoot, directory);
  let rootStat;
  try {
    rootStat = await fs.lstat(requestedAgentRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { sessions: [], skippedFiles: 0 };
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { sessions: [], skippedFiles: 0 };
  }

  const canonicalAgentRoot = await fs.realpath(requestedAgentRoot);
  if (!isInside(canonicalLibraryRoot, canonicalAgentRoot)) {
    throw new Error('agent directory resolves outside the session library');
  }

  const sessions = [];
  let skippedFiles = 0;
  async function walk(directoryPath) {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch (error) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md'
          || !isRejectedFile(error)) throw error;
        skippedFiles += 1;
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const canonicalDirectory = await fs.realpath(absolutePath);
        if (!isInside(canonicalAgentRoot, canonicalDirectory)) continue;
        await walk(canonicalDirectory);
        continue;
      }
      if (!stat.isFile() || path.extname(entry.name).toLowerCase() !== '.md') {
        continue;
      }

      let readResult;
      try {
        readResult = await readSessionFile(absolutePath, canonicalAgentRoot);
      } catch (error) {
        if (!isRejectedFile(error)) throw error;
        skippedFiles += 1;
        continue;
      }
      const { buf, fdStat } = readResult;
      const relativePath = path.relative(
        canonicalLibraryRoot,
        absolutePath,
      ).split(path.sep).join('/');
      const { frontmatter, body } = parseFrontmatter(buf.toString('utf8'));
      const sourceMtime = Date.parse(frontmatter.source_mtime || '');
      const fallbackTitle = path.basename(entry.name, path.extname(entry.name));
      const titleMetadata = {
        ...frontmatter,
        source: agent === 'codex' ? 'codex' : 'claude',
      };
      sessions.push({
        id: relativePath,
        relativePath,
        title: resolveSessionTitle(titleMetadata, fallbackTitle),
        body,
        agent,
        sessionsImport: true,
        sourceMtime: Number.isFinite(sourceMtime)
          ? sourceMtime
          : fdStat.mtimeMs,
        mtime: fdStat.mtimeMs,
        messageCount: messageCount(body),
      });
    }
  }

  await walk(canonicalAgentRoot);
  return { sessions, skippedFiles };
}

async function loadSessionLibrary(libraryPath) {
  if (typeof libraryPath !== 'string' || libraryPath.trim() === '') {
    throw new Error('session library path is required');
  }
  if (!path.isAbsolute(libraryPath)) {
    throw new Error('session library path must be absolute');
  }
  const rootStat = await fs.lstat(libraryPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('session library path must be a directory');
  }
  const canonicalLibraryRoot = await fs.realpath(libraryPath);
  const lists = await Promise.allSettled(
    AGENT_DIRECTORIES.map((entry) => collectAgentSessions({
      canonicalLibraryRoot,
      ...entry,
    })),
  );
  // Finish both scans before returning, including on fatal root failures.
  const failure = lists.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return {
    sessions: lists.flatMap((result) => result.value.sessions),
    skippedFiles: lists.reduce((sum, result) => sum + result.value.skippedFiles, 0),
  };
}

module.exports = {
  AGENT_DIRECTORIES,
  MAX_SESSION_BYTES,
  loadSessionLibrary,
  parseFrontmatter,
};
