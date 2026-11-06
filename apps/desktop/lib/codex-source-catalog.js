'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { scanCodexSourceTree } = require('./codex-source-traversal');

const INDEX_MAX_BYTES = 1024 * 1024;
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/;

function cancelled() { return Object.assign(new Error('Scan cancelled'), { code: 'SCAN_CANCELLED' }); }
function checkCancelled(signal) { if (signal?.aborted) throw cancelled(); }
function invalidSource() { return Object.assign(new Error('Invalid source'), { code: 'INVALID_SOURCE' }); }

function safeTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

function publicEntry(entry) {
  return { entryId: entry.entryId, sessionId: entry.sessionId, title: entry.title,
    updatedAt: entry.updatedAt, bytes: entry.bytes, area: entry.area, ...(entry.cwd ? { cwd: entry.cwd } : {}) };
}

function toPublicCatalog(catalog) {
  return { layout: catalog.layout, titleIndexState: catalog.titleIndexState, sourceId: catalog.sourceId, generation: catalog.generation,
    entries: catalog.entries.map(publicEntry), diagnostics: { ...catalog.diagnostics } };
}

function readTitles(content, diagnostics) {
  const names = new Map();
  for (const line of String(content || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id || !ROLLOUT_RE.test(`rollout-0000-00-00T00-00-00-${id}.jsonl`)) continue;
      if (typeof item.thread_name !== 'string') { diagnostics.indexErrors += 1; continue; }
      const title = safeTitle(item.thread_name);
      if (title) names.set(id, title);
      else names.delete(id);
    } catch { diagnostics.indexErrors += 1; }
  }
  return names;
}

async function scanCodexSource(selectedRoot, options = {}) {
  const fsApi = options.fsApi || fs;
  const signal = options.signal;
  checkCancelled(signal);
  if (typeof selectedRoot !== 'string' || !path.isAbsolute(selectedRoot) || path.resolve(selectedRoot) !== selectedRoot) {
    throw invalidSource();
  }
  let rootStat;
  let canonicalRoot;
  try {
    rootStat = await fsApi.lstat(selectedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw invalidSource();
    canonicalRoot = await fsApi.realpath(selectedRoot);
  } catch (error) {
    if (error?.code === 'SCAN_CANCELLED' || error?.code === 'INVALID_SOURCE') throw error;
    throw invalidSource();
  }
  checkCancelled(signal);
  const scanTree = options.scanTree || scanCodexSourceTree;
  const native = await scanTree(canonicalRoot, {
    signal,
    helperPath: options.helperPath,
    platform: options.platform,
    spawn: options.spawn,
  });
  checkCancelled(signal);

  const diagnostics = { skipped: native.diagnostics.skipped, errors: native.diagnostics.errors,
    skippedReasons: native.diagnostics.skippedReasons, named: 0, hiddenReviews: 0, duplicates: 0, indexErrors: native.diagnostics.indexErrors || 0 };
  const titles = readTitles(native.indexContent, diagnostics);
  const candidates = native.candidates.filter(candidate => !options.activeOnly || candidate.area === 'active').map((candidate) => ({
    ...candidate,
    filePath: path.join(canonicalRoot, candidate.relativePath),
    canonicalRoot,
  }));
  candidates.sort((a, b) => (a.area === b.area ? 0 : a.area === 'active' ? -1 : 1) ||
    Number(a.fileName.endsWith('.zst')) - Number(b.fileName.endsWith('.zst')) ||
    b.updatedAt - a.updatedAt || a.relativePath.localeCompare(b.relativePath));
  const unique = new Map();
  for (const candidate of candidates) {
    if (unique.has(candidate.sessionId)) diagnostics.duplicates += 1;
    else unique.set(candidate.sessionId, candidate);
  }
  const makeOpaqueId = options.makeOpaqueId || randomUUID;
  const entries = [...unique.values()].filter(entry => {
    // Exact, index-backed presentation rule, not body inspection or deletion.
    if (options.activeOnly && !options.deferReviewClassification && titles.get(entry.sessionId) === 'Guardian review') {
      diagnostics.hiddenReviews++; return false;
    }
    return true;
  }).map((entry) => ({
    ...entry,
    entryId: makeOpaqueId(),
    hasTitle: titles.has(entry.sessionId),
    title: titles.get(entry.sessionId) || entry.sessionId.slice(0, 8),
  })).sort((a, b) => (a.area === b.area ? 0 : a.area === 'active' ? -1 : 1) ||
    b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  diagnostics.named = entries.filter((entry) => titles.has(entry.sessionId)).length;
  const catalog = {
    titleIndexState: native.titleIndexState,
    layout: native.layout,
    sourceId: createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 32),
    canonicalRoot,
    generation: 0,
    entries,
    diagnostics,
    scanMetrics: { visited: native.visited, helperPeakRssBytes: native.helperPeakRssBytes,
      parentPeakRssBytes: native.parentPeakRssBytes },
  };
  catalog.publicCatalog = toPublicCatalog(catalog);
  return catalog;
}

module.exports = { scanCodexSource, toPublicCatalog, INDEX_MAX_BYTES, ROLLOUT_RE };
