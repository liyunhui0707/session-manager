// Stage S3 — fake-document helper shared by the read-renderer tests.
// Records writes to innerHTML / outerHTML / insertAdjacentHTML so each
// test can assert `doc.unsafeApiWrites === 0`. The renderer must NEVER
// touch any of those even for clearing (SC-S3-5).

'use strict';

function makeFakeDocument() {
  let unsafeApiWrites = 0;

  function makeElement(tag) {
    const el = {
      tag,
      tagName: String(tag).toUpperCase(),
      attrs: {},
      children: [],
      textContent: '',
      appendChild(child) {
        if (child && child.nodeType === 11) {
          // Document fragments dissolve on appendChild — their children
          // become children of `this`. Matches real DOM semantics.
          for (const c of child.children.slice()) {
            this.children.push(c);
            c.parent = this;
          }
          child.children.length = 0;
          return child;
        }
        this.children.push(child);
        child.parent = this;
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        return child;
      },
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      getAttribute(name) {
        return this.attrs[name];
      },
      get firstChild() {
        return this.children.length > 0 ? this.children[0] : null;
      },
      get innerHTML() {
        // Read access is fine; the SC-S3-5 invariant only bans WRITES.
        return '';
      },
      set innerHTML(_v) {
        unsafeApiWrites += 1;
      },
      get outerHTML() {
        return '';
      },
      set outerHTML(_v) {
        unsafeApiWrites += 1;
      },
      insertAdjacentHTML(_pos, _str) {
        unsafeApiWrites += 1;
      },
    };
    return el;
  }

  function makeText(text) {
    return { nodeType: 3, textContent: String(text == null ? '' : text) };
  }

  function makeFragment() {
    const f = {
      nodeType: 11,
      tag: '#fragment',
      children: [],
      appendChild(child) {
        if (child && child.nodeType === 11) {
          // Document fragments dissolve on appendChild — their children
          // become children of `this`. Matches real DOM semantics.
          for (const c of child.children.slice()) {
            this.children.push(c);
            c.parent = this;
          }
          child.children.length = 0;
          return child;
        }
        this.children.push(child);
        child.parent = this;
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        return child;
      },
      get firstChild() {
        return this.children.length > 0 ? this.children[0] : null;
      },
    };
    return f;
  }

  return {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => makeText(text),
    createDocumentFragment: () => makeFragment(),
    get unsafeApiWrites() {
      return unsafeApiWrites;
    },
  };
}

// Recursively flatten a node's textContent for assertions.
function flattenText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  if (node.children && node.children.length) {
    return node.children.map(flattenText).join('');
  }
  return node.textContent || '';
}

// Recursively find first descendant with matching tag (lowercase).
function findByTag(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  if (node.children) {
    for (const c of node.children) {
      const found = findByTag(c, tag);
      if (found) return found;
    }
  }
  return null;
}

// All descendants with a given tag.
function findAllByTag(node, tag) {
  const out = [];
  function walk(n) {
    if (!n) return;
    if (n.tag === tag) out.push(n);
    if (n.children) n.children.forEach(walk);
  }
  walk(node);
  return out;
}

module.exports = {
  makeFakeDocument,
  flattenText,
  findByTag,
  findAllByTag,
};
