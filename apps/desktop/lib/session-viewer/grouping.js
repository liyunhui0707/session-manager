// Stage S5 — sidebar grouping & sorting for AI Sessions.
//
// Verbatim port of Local-Web-Server/public/grouping.js. Pure
// function — takes the editor's session-item list (already adapted
// from `notes` via the in-renderer adapter) and returns the grouped
// tree the renderer paints. No DOM, no fetch, no module-level state.
//
// Item shape:
//   { id, title, relativePath, agent: 'codex'|'claude'|'other',
//     mtime, sourceMtime?, messageCount? }
//
// Output shape:
//   { codex: [layer], claude: [layer], other: [item], counts,
//     favorite?: [layer] }   where layer = { label, items, layerId }
//
// IIFE-wrapped + dual CJS/window export.

'use strict';

(function () {

// Stage S5 round-2 QA fix (T2): simplified to 3 layers per user
// feedback. Was: today / yesterday / w3 / w7 / older. Now:
//   today    — day delta <= 0 (today or future-dated)
//   w3       — day delta 1..3
//   older    — day delta > 3
const LAYER_ORDER = ['today', 'w3', 'older'];
const LAYER_LABEL = {
  today: '今天',
  w3: '近三天',
  older: '更早',
};

function layerOf(d) {
  if (d <= 0) return 'today';
  if (d <= 3) return 'w3';
  return 'older';
}

function localEpochDay(input) {
  const d = new Date(input);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

function sortList(items, sort, useSourceMtime) {
  const timeOf = (it) =>
    new Date(useSourceMtime ? (it.sourceMtime || it.mtime) : it.mtime).getTime();
  const nameOf = (it) => it.title || it.name || '';
  if (sort === 'oldest') items.sort((a, b) => timeOf(a) - timeOf(b));
  else if (sort === 'name') items.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  else items.sort((a, b) => timeOf(b) - timeOf(a));
  return items;
}

function countAgent(items) {
  let messages = 0;
  for (const item of items) {
    if (typeof item.messageCount === 'number') messages += item.messageCount;
  }
  return { sessions: items.length, messages };
}

function bucketize(items, today, sort) {
  if (items.length === 0) return [];
  const todayEpoch = localEpochDay(today);
  const buckets = new Map();
  for (const item of items) {
    const d = new Date(item.sourceMtime || item.mtime);
    const eDay = localEpochDay(d);
    const layerId = layerOf(todayEpoch - eDay);
    if (!buckets.has(layerId)) {
      buckets.set(layerId, { label: LAYER_LABEL[layerId], items: [], layerId });
    }
    buckets.get(layerId).items.push(item);
  }
  for (const b of buckets.values()) sortList(b.items, sort, true);
  const out = [];
  for (const id of LAYER_ORDER) {
    if (buckets.has(id)) out.push(buckets.get(id));
  }
  return out;
}

function groupAndSort(items, opts) {
  opts = opts || {};
  const sort = opts.sort || 'newest';
  const today = opts.today || new Date();
  const isFavorite = opts.isFavorite;
  const codex = [];
  const claude = [];
  const other = [];
  for (const item of items || []) {
    if (!item) continue;
    if (item.agent === 'codex') codex.push(item);
    else if (item.agent === 'claude') claude.push(item);
    else other.push(item);
  }
  // Stage S5 round-1 diff-review M1 fix: bucketize `other` the same
  // way as codex/claude so all 3 agent groups have a uniform tree
  // shape (Today / Yesterday / W3 / W7 / Older). Diverges from
  // upstream's `other: sortList(...)` (flat) — uniformity matches
  // the S5 scope_summary that says "each agent group bucketed".
  const result = {
    codex: bucketize(codex, today, sort),
    claude: bucketize(claude, today, sort),
    other: bucketize(other, today, sort),
    counts: {
      codex: countAgent(codex),
      claude: countAgent(claude),
      other: countAgent(other),
    },
  };
  if (typeof isFavorite === 'function') {
    // Stage S5 round-2 QA fix (T2): the Favorites group renders FLAT
    // (no date buckets). User wants quick access to starred sessions
    // without the date-bucket noise. Agent groups (codex/claude/other)
    // still bucketize for organisation.
    const favs = (items || []).filter((it) => it && isFavorite(it));
    result.favorite = sortList(favs.slice(), sort, true);
    result.counts.favorite = countAgent(favs);
  }
  return result;
}

// Stage 6.6 — flatten the grouped tree into the visible row order
// (Favorites → Codex (Today / W3 / Older) → Claude (same) → Other),
// optionally skipping rows the user can't currently see because their
// containing group or bucket is collapsed. Used by the keyboard arrow
// handler so ↑/↓ traverse exactly what the user sees in the sidebar.
//
// `tree` is the object returned by `groupAndSort`.
// `opts.isGroupCollapsed(groupKey)`  — return true to skip the whole group.
// `opts.isBucketCollapsed(groupKey, layerId)` — return true to skip just
//   that bucket's rows (the group header still counts as visible).
const SESSION_GROUP_ORDER = ['favorite', 'codex', 'claude', 'other'];
function flattenVisibleGroupedTree(tree, opts) {
  opts = opts || {};
  const isGroupCollapsed  = typeof opts.isGroupCollapsed  === 'function' ? opts.isGroupCollapsed  : () => false;
  const isBucketCollapsed = typeof opts.isBucketCollapsed === 'function' ? opts.isBucketCollapsed : () => false;
  const out = [];
  if (!tree) return out;
  for (const groupKey of SESSION_GROUP_ORDER) {
    const contents = tree[groupKey];
    if (!contents || isGroupCollapsed(groupKey)) continue;
    if (groupKey === 'favorite') {
      // Favorites render flat (no buckets) — items are the contents.
      for (const item of contents) {
        if (item) out.push(item);
      }
      continue;
    }
    // codex / claude / other render bucketed.
    for (const bucket of contents) {
      if (!bucket) continue;
      if (isBucketCollapsed(groupKey, bucket.layerId)) continue;
      for (const item of bucket.items || []) {
        if (item) out.push(item);
      }
    }
  }
  return out;
}

const api = {
  groupAndSort,
  flattenVisibleGroupedTree,
  SESSION_GROUP_ORDER,
  LAYER_ORDER,
  LAYER_LABEL,
  // Exported for direct testing:
  layerOf,
  localEpochDay,
  bucketize,
  sortList,
  countAgent,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
