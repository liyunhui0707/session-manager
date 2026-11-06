'use strict';
const { createHash } = require('node:crypto');
const { STRIDE, LOOKBACK, boundary } = require('./codex-page-text-boundaries');
const INLINE_BYTES = 2 * 1024 ** 2;
// Locale-independent matching; treating both Greek sigma forms alike also
// removes lowercasing's dependency on the following stream chunk.
const fold = text => text.toLowerCase().replace(/ς/g, 'σ');
function originalOffset(text, foldedAt) {
  let at = 0, lower = 0;
  for (const char of text) {
    const width = fold(char).length;
    if (lower + width > foldedAt) break;
    lower += width; at += char.length;
  }
  return at;
}
class TextState {
  constructor(query = '', previous) {
    this.query = query;
    this.hash = previous ? previous.hash.copy() : createHash('sha256');
    this.length = previous?.length || 0;
    this.bytes = previous?.bytes || 0;
    this.head = previous?.head || '';
    this.tail = previous?.tail || '';
    this.hit = previous?.hit ? { ...previous.hit } : null;
    this.inline = previous ? (previous.inline && [...previous.inline]) : [];
    this.boundaryTail = previous?.boundaryTail || '';
    this.lastCut = previous?.lastCut && { ...previous.lastCut };
  }
  clone() { return new TextState(this.query, this); }
  write(text) {
    const boundaryWindow = this.boundaryTail + text;
    const base = this.length - this.boundaryTail.length;
    const cut = (Math.floor(this.length / STRIDE) + 1) * STRIDE;
    if (cut <= this.length + text.length) {
      this.lastCut = { cut, start: boundary(boundaryWindow, cut, base) };
      if (this.hit && this.hit.at < cut && this.hit.at >= cut - STRIDE) this.hit.cut = this.lastCut;
    }
    this.boundaryTail = boundaryWindow.slice(-LOOKBACK);
    if (this.inline) {
      if (this.bytes + Buffer.byteLength(text) <= INLINE_BYTES) this.inline.push(text);
      else this.inline = null;
    }
    this.hash.update(text, 'utf16le');
    if (this.head.length < 128) this.head = (this.head + (this.head ? text : text.trimStart())).slice(0, 128);
    if (this.query) {
      if (this.hit) {
        if (this.hit.remaining) {
          const extra = text.slice(0, this.hit.remaining);
          this.hit.snippet += extra; this.hit.remaining -= extra.length;
        }
      } else {
        const window = this.tail + text, lower = fold(window), found = lower.indexOf(this.query);
        if (found >= 0) {
          const at = lower.length === window.length ? found : originalOffset(window, found);
          this.hit = { at: this.length - this.tail.length + at,
            snippet: window.slice(Math.max(0, at - 40), at + 160),
            remaining: Math.max(0, at + 160 - window.length) };
          if (this.lastCut && this.hit.at < this.lastCut.cut) this.hit.cut = this.lastCut;
        }
        this.tail = window.slice(-this.query.length * 2 - 80);
      }
    }
    this.length += text.length; this.bytes += Buffer.byteLength(text);
  }
  summary() {
    return { length: this.length, bytes: this.bytes, head: this.head,
      digest: this.hash.copy().digest('hex'), hit: this.hit && { ...this.hit },
      text: this.inline ? this.inline.join('') : undefined };
  }
}
module.exports = { TextState, fold, originalOffset };
