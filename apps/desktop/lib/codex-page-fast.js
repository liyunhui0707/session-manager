'use strict';
const { createConversationProjection } = require('./codex-page-projection');
const SMALL_RECORD_BYTES = 32 * 1024;
const payloadKeys = new Set(['type','role','phase','channel','message','last_agent_message','content']);
const limit = () => { throw Object.assign(new Error('JSON_LIMIT'), { code: 'JSON_LIMIT' }); };
function childPath(frame) {
  if (!frame) return [];
  const p = frame.path, key = frame.kind === 'array' ? '*' : frame.key;
  if (!p) return null;
  if (!p.length && ['type','payload'].includes(key)) return [key];
  if (p.length === 1 && p[0] === 'payload' && payloadKeys.has(key)) return [...p,key];
  if (p.join('.') === 'payload.content' && key === '*') return [...p,key];
  if (p.join('.') === 'payload.content.*' && ['type','text'].includes(key)) return [...p,key];
  return null;
}
function project(value, options, stack = []) {
  const p = childPath(stack.at(-1));
  if (value && typeof value === 'object') {
    if (stack.length >= 128) limit();
    const array = Array.isArray(value);
    if (p && array && value.length > 4096) limit();
    const frame = { path:p, kind:array?'array':'object', value:p?(array?[]:Object.create(null)):undefined, key:null };
    stack.push(frame);
    for (const key of Object.keys(value)) {
      frame.key = key; const v = project(value[key],options,stack);
      if (p && array) frame.value.push(v === undefined ? null : v);
      else if (p && childPath(frame)) frame.value[key] = v;
    }
    options.finishContainer?.(frame); stack.pop(); return frame.value;
  }
  if (!p) return undefined;
  if (typeof value === 'string') {
    if (['text','message','last_agent_message'].includes(p.at(-1))) {
      const sink = options.createText?.(stack);
      if (!sink) return value;
      // Match the streaming string decoder's bounded UTF-16 chunk boundaries.
      for (let i=0;i<value.length;) {
        let end=Math.min(value.length,i+4096);
        if (end<value.length && /[\ud800-\udbff]/.test(value[end-1])) end--;
        sink.write(value.slice(i,end));i=end;
      }
      return sink.finish();
    }
    if (JSON.stringify(value).length > 8192) limit();
  }
  return value;
}
// Native JSON decoding only for bounded, exactly round-trippable records.
// Duplicate keys, alternate escaping/numbers and large records use the original
// streaming parser, preserving its lexical checks and field-reference ordering.
function createFastProjection(options = {}) {
  let buffers=[], bytes=0, stream=null, fast=false;
  const fallback = () => { stream=createConversationProjection(options); for(const b of buffers)stream.write(b); buffers=[]; };
  return {
    write(buffer) {
      if(stream) return stream.write(buffer);
      bytes+=buffer.length; buffers.push(buffer);
      if(bytes>SMALL_RECORD_BYTES) fallback();
    },
    finish() {
      if(stream) return stream.finish();
      const raw=Buffer.concat(buffers,bytes).toString('utf8').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
      let value;
      try { value=JSON.parse(raw); } catch { fallback(); return stream.finish(); }
      if(JSON.stringify(value)!==raw) { fallback(); return stream.finish(); }
      buffers=[];fast=true;return project(value,options);
    },
    get fast(){return fast;},
  };
}
module.exports={createFastProjection,SMALL_RECORD_BYTES};
