'use strict';
const { createZstdSession } = require('./codex-page-zstd-stream');
const { textParts } = require('./codex-page-text-parts');
const { textProjection, textPolicy } = require('./codex-page-text-projection');
const { materialize } = require('./codex-page-text-capture');
const { createPageWindow } = require('./codex-page-window');
const { makeCheckpoint } = require('./codex-page-append');
const { createSeekIndex } = require('./codex-page-seek');
const { fold, originalOffset } = require('./codex-page-text-state');
const { createTurnReader } = require('./codex-page-turns');
const { parseCodexConversation } = require('./codex-conversation');
const { parentPort, workerData } = require('node:worker_threads');
const { describeMessage } = require('./session-viewer/conversation-presentation');
const { extractConversationTextRuns } = require('./session-viewer/read-search-text');
async function readConversation(data) {
  if (data.query !== undefined && (typeof data.query !== 'string' || data.query.length > 1000)) {
    throw Object.assign(new Error('INVALID_REQUEST'), { code: 'INVALID_REQUEST' });
  }
  const canAppend = data.query === undefined && data.page === undefined && !data.validateOnly;
  const options = { allowPlain: true, projectConversation: true,
    projectionOptions: record => textProjection(record, data.query), trackAppend: canAppend,
    append: canAppend ? data.append : null, resume: data.seek?.point };
  let stream;
  try { stream = await createZstdSession(data.source, options); }
  catch (error) {
    if (error.code !== 'APPEND_MISMATCH') throw error;
    stream = await createZstdSession(data.source, { ...options, append: null });
  }
  if (data.validateOnly) {
    // Opening verifies the path, ancestors, descriptor identity and supplied
    // snapshot. The stream is lazy: no transcript bytes are read here.
    try { return { snapshot: stream.snapshot }; } finally { await stream.close(); }
  }
  const resumed = data.seek ? structuredClone(data.seek.point.state) : stream.appendResumed ? structuredClone(data.append.state) : null;
  const index = createSeekIndex(data.seek?.index || (stream.appendResumed ? data.index : null));
  const buildIndex = data.query === undefined && !data.seek;
  const window = createPageWindow(data.page);
  for (const entry of resumed?.window || []) window.add(entry.number, entry.messages);
  const retain = () => { if (data.query === undefined) window.add(page, messages); };
  const diagnostics = resumed?.diagnostics || { ...parseCodexConversation('').diagnostics, oversizedRecords: 0, oversizedMessages: 0 };
  let page = resumed?.page || 0, textBytes = resumed?.textBytes || 0, messages = resumed?.messages || [],
    selected = null, count = resumed?.count || 0, totalMatches = 0;
  let records = data.seek?.point.records ?? (stream.appendResumed ? data.append.records : 0), parsedRecords = 0, terminated = true, early = false;
  const matches = [], query = data.query && fold(data.query);
  const collect = message => {
    const body = message.text;
    let hit = body.hit;
    if (query && body.text !== undefined && describeMessage(body.text, message.role)) {
      const visible = extractConversationTextRuns({ messages: [{ role: message.role, text: body.text }] })
        .find(text => fold(text).includes(query));
      const at = visible ? originalOffset(visible, fold(visible).indexOf(query)) : -1;
      hit = visible ? { at: 0, snippet: visible.slice(Math.max(0, at - 40), at + 160) } : null;
    }
    const { parts, total } = textParts(message.role, body);
    let hitAt = hit?.at;
    if (body.text === undefined && total > 1 && hit?.cut && hit.cut.cut < body.length && hit.cut.start <= hitAt) hitAt = hit.cut.cut;
    for (const part of parts) {
      if (messages.length && (total > 1 || messages.length >= 100 || textBytes + part.bytes > 512 * 1024)) {
        if (page === data.page) selected = messages;
        retain();
        messages = []; textBytes = 0; page++;
        if (page >= 100000) throw Object.assign(new Error('READ_LIMIT'), { code: 'READ_LIMIT' });
      }
      // Search the whole original body, including matches crossing part boundaries.
      // For presentation envelopes there is one intact card, so offsets map to it.
      if (hit && (total === 1 || (hitAt >= part.start && hitAt < part.end))) {
        if (totalMatches >= (data.matchOffset || 0) && matches.length < (data.matchLimit || 200))
          matches.push({ page, message: messages.length, snippet: hit.snippet });
        totalMatches++;
      }
      messages.push(part.message); textBytes += part.bytes;
    }
    count++;
  };
  const turns = createTurnReader(collect, textPolicy, resumed?.turn);
  try {
    reading: for await (const batch of stream.rawRecordBatches()) {
      for (const record of batch) {
        records++; parsedRecords++; terminated = record.terminated;
        if (record.oversized) { diagnostics.oversizedRecords++; turns.discontinuity(); continue; }
        if (record.oversizedMessage) { diagnostics.oversizedMessages++; turns.discontinuity(); continue; }
        if (record.malformed) {
          diagnostics[record.terminated ? 'malformedRecords' : 'unparsedFinalRecord']++;
          turns.discontinuity(); continue;
        }
        try { turns.accept(record.value); }
        catch (error) {
          if (error.code === 'MESSAGE_TOO_LARGE') {
            diagnostics.oversizedMessages++; turns.discontinuity(); continue;
          }
          throw error;
        }
        if (buildIndex && terminated) index.consider(page, record.end, records, () => ({
          page, textBytes, messages, count, diagnostics, turn: turns.checkpoint(), window: [] }));
        if (data.seek && page > data.page + 1) { early = true; break reading; }
      }
    }
    await stream.verify();
    const digest = stream.appendDigest;
    const append = digest && terminated ? makeCheckpoint({ snapshot: stream.snapshot, digest,
      offset: stream.snapshot.size, records }, { page, textBytes, messages, count, diagnostics,
      turn: turns.checkpoint(), window: window.entries() }) : null;
    const state = early ? data.seek.summary : turns.finish();
    retain();
    if (data.page === page || data.page === undefined) selected = messages;
    if (data.page !== undefined && data.page > page) throw Object.assign(new Error('PAGE_UNAVAILABLE'), { code: 'PAGE_UNAVAILABLE' });
    await stream.close();
    const cachedPages = window.entries();
    // Materialize neighboring descriptor-backed pages in the same verified
    // replay, without duplicating the selected page's capture destinations.
    const visible = selected || [];
    const retained = [...new Set([...cachedPages.map(p => p.messages), visible])];
    if (data.query === undefined) await materialize(data.source, stream.snapshot, retained.flat());
    return { conversation: { messages: visible, diagnostics: early ? data.seek.summary.diagnostics : diagnostics }, snapshot: stream.snapshot,
      window: cachedPages, index: data.seek?.index || (buildIndex ? index.snapshot() : null),
      append,
      work: { incremental: !!stream.appendResumed, parsedRecords, verifiedPrefixBytes: stream.appendResumed ? data.append.offset : 0,
        ...(data.seek ? { indexed: true } : {}) },
      ...state, number: data.page ?? page, pages: early ? data.seek.summary.pages : page + 1, count: early ? data.seek.summary.count : count, matches, totalMatches, moreMatches: totalMatches > (data.matchOffset || 0) + matches.length,
      incomplete: early ? data.seek.summary.incomplete : !!(diagnostics.oversizedRecords || diagnostics.oversizedMessages || diagnostics.malformedRecords || diagnostics.unparsedFinalRecord) };
  } finally { await stream.close(); }
}
if (parentPort) readConversation(workerData).then(
  result => parentPort.postMessage({ ok: true, result }),
  error => parentPort.postMessage({ ok: false, code: [
    'SOURCE_CHANGED', 'RECORD_TOO_LARGE', 'MESSAGE_TOO_LARGE', 'PLATFORM_UNSUPPORTED',
    'DECOMPRESSION_FAILED', 'DECOMPRESSION_LIMIT', 'PAGE_UNAVAILABLE', 'READ_LIMIT',
  ].includes(error.code) ? error.code : 'INVALID_SOURCE' }),
);
module.exports = { readConversation };
