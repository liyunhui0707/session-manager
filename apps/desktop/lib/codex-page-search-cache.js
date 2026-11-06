'use strict';
const MAX_BYTES = 4 * 1024 ** 2, MAX_ENTRIES = 4, WINDOW = 1000;
function createSearchCache(run) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => { const old = entries.get(key); if (old) bytes -= old.bytes; entries.delete(key); };
  return {
    async search(source, query, { offset = 0, limit = 200 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
        throw Object.assign(new Error('INVALID_REQUEST'), { code: 'INVALID_REQUEST' });
      const group = JSON.stringify([source.canonicalRoot, source.filePath, query]);
      let cached = [...entries.values()].find(value => value.group === group && offset >= value.offset &&
        (offset + limit <= value.offset + value.result.matches.length || value.offset + value.result.matches.length === value.result.totalMatches));
      let key = cached?.key || JSON.stringify([group, offset]);
      if (cached && source.snapshot && JSON.stringify(source.snapshot) !== JSON.stringify(cached.result.snapshot)) cached = null;
      if (cached && offset >= cached.offset && (offset + limit <= cached.offset + cached.result.matches.length ||
          cached.offset + cached.result.matches.length === cached.result.totalMatches)) {
        try { await run({ ...source, snapshot: cached.result.snapshot }, { validateOnly: true }); }
        catch (error) {
          for (const [oldKey, value] of entries) if (value.group === group) remove(oldKey);
          if (error.code !== 'SOURCE_CHANGED' || source.snapshot) throw error;
          cached = null;
        }
      } else cached = null;
      if (!cached) {
        const result = await run(source, { query, matchOffset: offset, matchLimit: WINDOW });
        // Retain only bounded snippets and snapshot metadata, never page bodies.
        const stored = { matches: result.matches, totalMatches: result.totalMatches,
          count: result.count, work: result.work, snapshot: result.snapshot, incomplete: result.incomplete };
        key = JSON.stringify([group, offset]);
        cached = { key, group, result: stored, offset, bytes: Buffer.byteLength(JSON.stringify(stored)) };
        remove(key);
        if (cached.bytes <= MAX_BYTES) { entries.set(key, cached); bytes += cached.bytes; }
        while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) remove(entries.keys().next().value);
      } else { entries.delete(key); entries.set(key, cached); }
      const start = offset - cached.offset;
      const matches = cached.result.matches.slice(start, start + limit);
      const nextOffset = offset + matches.length < cached.result.totalMatches ? offset + matches.length : null;
      return { ...cached.result, matches, moreMatches: nextOffset !== null, nextOffset };
    },
    usage: () => ({ searchEntries: entries.size, searchBytes: bytes }),
    clear() { entries.clear(); bytes = 0; },
  };
}
module.exports = { createSearchCache };
