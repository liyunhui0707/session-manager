// Stage S5 — headless renderer for the AI Sessions grouped tree.
//
// Takes the groupAndSort output + a target container + click
// callbacks and builds the DOM via createElement + createTextNode.
// No `innerHTML` writes (SC-S5-2 carries forward from S3/S4).
//
// Layout:
//   <div class="session-group" data-group-key="favorite">
//     <div class="session-group-header" data-group-key="favorite">
//       <span class="session-group-chevron">▾</span>
//       <span class="session-group-title">Favorites</span>
//       <span class="session-group-count">3 sessions</span>
//     </div>
//     <div class="session-group-body">
//       <div class="session-bucket">
//         <div class="session-bucket-header">Today</div>
//         <div class="session-row" data-note-id="..." data-rel="...">
//           <span class="session-star session-star--on">★</span>
//           <span class="session-row-title">title</span>
//           <span class="note-badge ...">badge</span>
//         </div>
//         ...
//       </div>
//     </div>
//   </div>
//
// Collapsed state: `.session-group-header--collapsed` class on the
// header AND `hidden` on the body. Caller controls via isCollapsed.
//
// IIFE-wrapped + dual CJS/window export.

'use strict';

(function () {

const GROUP_ORDER = ['favorite', 'codex', 'claude', 'other'];
const GROUP_LABEL = {
  favorite: '收藏',
  codex: 'Codex',
  claude: 'Claude',
  other: '其他',
};

function clearChildren(node) {
  if (!node) return;
  if (Array.isArray(node.children)) {
    node.children.length = 0;
    return;
  }
  while (node.firstChild) node.removeChild(node.firstChild);
}

function createGroupedListRenderer(opts) {
  if (!opts) throw new Error('createGroupedListRenderer: opts required');
  const {
    container,
    document: doc,
    favoritesController,
    onRowClick,
    onStarClick,
    onHeaderToggle,
    isCollapsed,
    // Stage S5 round-3 QA fix (issue B): bucket-level collapse.
    onBucketToggle,
    isBucketCollapsed,
  } = opts;
  if (!container) throw new Error('createGroupedListRenderer: container required');
  if (!doc) throw new Error('createGroupedListRenderer: document required');
  if (!favoritesController) throw new Error('createGroupedListRenderer: favoritesController required');

  function makeHeader(groupKey, count) {
    const header = doc.createElement('div');
    const collapsed = typeof isCollapsed === 'function' && isCollapsed(groupKey);
    header.setAttribute(
      'class',
      collapsed
        ? 'session-group-header session-group-header--collapsed'
        : 'session-group-header',
    );
    header.setAttribute('data-group-key', groupKey);
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

    const chev = doc.createElement('span');
    chev.setAttribute('class', 'session-group-chevron');
    chev.appendChild(doc.createTextNode(collapsed ? '▸' : '▾'));
    header.appendChild(chev);

    const title = doc.createElement('span');
    title.setAttribute('class', 'session-group-title');
    title.appendChild(doc.createTextNode(GROUP_LABEL[groupKey] || groupKey));
    header.appendChild(title);

    const c = doc.createElement('span');
    c.setAttribute('class', 'session-group-count');
    const sessionsN = (count && count.sessions) || 0;
    c.appendChild(doc.createTextNode(`${sessionsN} session${sessionsN === 1 ? '' : 's'}`));
    header.appendChild(c);

    if (typeof header.addEventListener === 'function' && typeof onHeaderToggle === 'function') {
      header.addEventListener('click', () => onHeaderToggle(groupKey));
      header.addEventListener('keydown', (e) => {
        if (e && (e.key === 'Enter' || e.key === ' ')) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          onHeaderToggle(groupKey);
        }
      });
    } else {
      header.__onClick = () => { if (typeof onHeaderToggle === 'function') onHeaderToggle(groupKey); };
    }

    return header;
  }

  function makeRow(item, currentSelectedId) {
    const row = doc.createElement('div');
    const isSelected = item && item.id === currentSelectedId;
    row.setAttribute(
      'class',
      isSelected ? 'session-row session-row--active' : 'session-row',
    );
    row.setAttribute('data-note-id', String(item.id || ''));
    row.setAttribute('data-rel', String(item.relativePath || ''));
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    if (item.title) row.setAttribute('title', String(item.title));

    const star = doc.createElement('span');
    const fav = favoritesController.isFavorite(item.relativePath);
    star.setAttribute(
      'class',
      fav ? 'session-star session-star--on' : 'session-star',
    );
    star.setAttribute('role', 'button');
    star.setAttribute('tabindex', '0');
    star.setAttribute('aria-pressed', fav ? 'true' : 'false');
    star.setAttribute(
      'aria-label',
      fav ? '取消收藏' : '收藏会话',
    );
    star.appendChild(doc.createTextNode(fav ? '★' : '☆'));
    row.appendChild(star);

    const titleSpan = doc.createElement('span');
    titleSpan.setAttribute('class', 'session-row-title');
    titleSpan.appendChild(doc.createTextNode(item.title || '未命名会话'));
    row.appendChild(titleSpan);

    if (item.badge && item.badge.kind && item.badge.label) {
      const b = doc.createElement('span');
      b.setAttribute('class', `note-badge note-badge-${item.badge.kind}`);
      b.appendChild(doc.createTextNode(item.badge.label));
      row.appendChild(b);
    }

    // Star click: stop propagation so the row click handler doesn't
    // also fire (which would change selection on every star toggle).
    if (typeof star.addEventListener === 'function' && typeof onStarClick === 'function') {
      star.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        onStarClick(item.relativePath, e);
      });
      star.addEventListener('keydown', (e) => {
        if (e && (e.key === 'Enter' || e.key === ' ')) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          if (typeof e.stopPropagation === 'function') e.stopPropagation();
          onStarClick(item.relativePath, e);
        }
      });
    } else {
      star.__onClick = () => { if (typeof onStarClick === 'function') onStarClick(item.relativePath); };
    }

    if (typeof row.addEventListener === 'function' && typeof onRowClick === 'function') {
      row.addEventListener('click', () => onRowClick(item.id));
      row.addEventListener('keydown', (e) => {
        if (e && (e.key === 'Enter' || e.key === ' ')) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          onRowClick(item.id);
        }
      });
    } else {
      row.__onClick = () => { if (typeof onRowClick === 'function') onRowClick(item.id); };
    }

    return row;
  }

  function makeBucket(bucket, currentSelectedId, groupKey) {
    const wrapper = doc.createElement('div');
    wrapper.setAttribute('class', 'session-bucket');
    wrapper.setAttribute('data-bucket-id', bucket.layerId);
    wrapper.setAttribute('data-group-key', groupKey);

    // Stage S5 round-3 QA fix (issue B): the bucket header now
    // toggles collapse for its bucket. State persisted by the caller
    // under a separate localStorage key, keyed by `<groupKey>:<layerId>`.
    const bucketCollapsed =
      typeof isBucketCollapsed === 'function' &&
      isBucketCollapsed(groupKey, bucket.layerId);

    const header = doc.createElement('div');
    header.setAttribute(
      'class',
      bucketCollapsed
        ? 'session-bucket-header session-bucket-header--collapsed'
        : 'session-bucket-header',
    );
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

    const bChev = doc.createElement('span');
    bChev.setAttribute('class', 'session-bucket-chevron');
    bChev.appendChild(doc.createTextNode(bucketCollapsed ? '▸' : '▾'));
    header.appendChild(bChev);

    const bLabel = doc.createElement('span');
    bLabel.setAttribute('class', 'session-bucket-label');
    bLabel.appendChild(doc.createTextNode(bucket.label));
    header.appendChild(bLabel);

    const bCount = doc.createElement('span');
    bCount.setAttribute('class', 'session-bucket-count');
    const n = (bucket.items || []).length;
    bCount.appendChild(doc.createTextNode(String(n)));
    header.appendChild(bCount);

    if (typeof header.addEventListener === 'function' && typeof onBucketToggle === 'function') {
      header.addEventListener('click', () => onBucketToggle(groupKey, bucket.layerId));
      header.addEventListener('keydown', (e) => {
        if (e && (e.key === 'Enter' || e.key === ' ')) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          onBucketToggle(groupKey, bucket.layerId);
        }
      });
    } else {
      header.__onClick = () => {
        if (typeof onBucketToggle === 'function') onBucketToggle(groupKey, bucket.layerId);
      };
    }
    wrapper.appendChild(header);

    if (!bucketCollapsed) {
      for (const item of bucket.items || []) {
        wrapper.appendChild(makeRow(item, currentSelectedId));
      }
    }
    return wrapper;
  }

  function makeGroupBody(groupKey, contents, currentSelectedId) {
    const body = doc.createElement('div');
    body.setAttribute('class', 'session-group-body');
    if (typeof isCollapsed === 'function' && isCollapsed(groupKey)) {
      body.hidden = true;
    }

    // Stage S5 round-2 QA fix (T2): the Favorites group renders flat
    // (the grouping module now returns a flat sorted array for
    // `favorite`); agent groups (codex/claude/other) keep buckets.
    if (groupKey === 'favorite') {
      for (const item of contents || []) {
        body.appendChild(makeRow(item, currentSelectedId));
      }
      return body;
    }
    for (const bucket of contents || []) {
      body.appendChild(makeBucket(bucket, currentSelectedId, groupKey));
    }
    return body;
  }

  function isGroupNonEmpty(groupKey, tree) {
    const c = tree[groupKey];
    if (!c) return false;
    if (groupKey === 'other') return Array.isArray(c) && c.length > 0;
    return Array.isArray(c) && c.length > 0;
  }

  function render(tree, currentSelectedId) {
    clearChildren(container);
    if (!tree) return;
    for (const groupKey of GROUP_ORDER) {
      if (!isGroupNonEmpty(groupKey, tree)) continue;
      const groupEl = doc.createElement('div');
      groupEl.setAttribute('class', 'session-group');
      groupEl.setAttribute('data-group-key', groupKey);
      const count = tree.counts && tree.counts[groupKey];
      groupEl.appendChild(makeHeader(groupKey, count));
      groupEl.appendChild(makeGroupBody(groupKey, tree[groupKey], currentSelectedId));
      container.appendChild(groupEl);
    }
  }

  return { render };
}

const api = { createGroupedListRenderer, GROUP_ORDER, GROUP_LABEL };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
