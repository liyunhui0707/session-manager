'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexLive } = require('../../lib/session-viewer/codex-live');
const { makeFakeDocument } = require('./read-fake-document');
function setup() {
  const document = makeFakeDocument(), elements = {};
  for (const name of ['root', 'form', 'input', 'scope', 'results', 'status', 'cancel', 'latest']) {
    const e = document.createElement('div'); e.addEventListener = () => {}; elements[name] = e;
  }
  let following = false, busy = false, syncResult = { ok: true, changed: false, bodyChanged: true };
  const calls = { latest: 0, applied: 0, search: 0 };
  const app = { getState: () => ({ sourceMode: 'folder' }), isBusy: () => busy,
    isFollowingLatest: () => following, syncCodexChanges: () => { calls.applied++; },
    showLatest: async () => { calls.latest++; return true; }, showCodexSearchHit() {} };
  const api = { syncCodexConversation: async () => syncResult,
    searchCodexConversations: async () => { calls.search++; return { ok: true, hits: [], complete: true, searched: 2, total: 2, failed: 0 }; } };
  const live = createCodexLive({ document, elements, app, api });
  return { live, calls, elements, api, setFollowing: v => { following = v; }, setBusy: v => { busy = v; }, setSync: v => { syncResult = v; } };
}
test('automatic updates preserve historical reading, show new-message action and follow only at the end', async () => {
  const h = setup();
  await h.live.tick(); assert.equal(h.calls.latest, 0); assert.equal(h.elements.latest.hidden, false);
  h.setFollowing(true); await h.live.tick(); assert.equal(h.calls.latest, 1);
  h.setBusy(true); await h.live.tick(); assert.equal(h.calls.latest, 1);
});
test('search is explicit, bounded input and reports completeness rather than implying partial results are complete', async () => {
  const h = setup();
  await h.live.search('  ', 'all'); assert.equal(h.calls.search, 0);
  await h.live.search('needle', 'all'); assert.equal(h.calls.search, 1);
  assert.match(h.elements.status.textContent, /2\/2/);
});
test('failed hit transport is contained, reported, and a later search remains usable', async () => {
  const document = makeFakeDocument(), make = document.createElement;
  document.createElement = tag => { const el = make(tag); el.listeners = {}; el.addEventListener = (n, fn) => { el.listeners[n] = fn; }; return el; };
  const elements = Object.fromEntries(['root','form','input','scope','results','status','cancel','latest'].map(n => [n, document.createElement('div')]));
  let calls = 0, opened = 0, fail = true;
  const live = createCodexLive({ document, elements, onOpen: () => { opened++; }, app: { isBusy: () => false, showCodexSearchHit() {} }, api: {
    searchCodexConversations: async () => { calls++; return { ok: true, hits: [{ hitId: 'synthetic', title: 'Synthetic', snippet: 'needle' }], searched: 1, total: 1, complete: true }; },
    openCodexSearchHit: async () => { if (fail) throw Error('synthetic transport failure'); return { ok: true }; },
  } });
  await live.search('needle', 'all');
  await assert.doesNotReject(elements.results.firstChild.listeners.click());
  assert.match(elements.status.textContent, /重新搜索/);
  await live.search('needle', 'all'); assert.equal(calls, 2);
  assert.equal(opened, 0, 'failed hits must leave the search dialog open');
  fail = false; await elements.results.firstChild.listeners.click();
  assert.equal(opened, 1, 'close the dialog only after the reader accepted the result');
});

test('late background sync cannot apply an old catalog or auto-follow after source navigation', async () => {
  const document = makeFakeDocument(), elements = {};
  for (const name of ['root','form','input','scope','results','status','cancel','latest']) {
    elements[name] = document.createElement('div'); elements[name].addEventListener = () => {};
  }
  let release, source = 'old', busy = false, applied = 0, followed = 0;
  const app = { getState: () => ({ sourceMode: 'folder', folder: { sourceId: source } }),
    isBusy: () => busy, isFollowingLatest: () => true,
    syncCodexChanges: () => { applied++; }, showLatest: async () => { followed++; return true; } };
  const live = createCodexLive({ document, elements, app, api: {
    syncCodexConversation: () => new Promise(resolve => { release = resolve; }),
  } });
  const first = live.tick(); source = 'new';
  release({ ok: true, changed: true, bodyChanged: true }); await first;
  assert.equal(applied, 0); assert.equal(followed, 0);
  const second = live.tick(); busy = true;
  release({ ok: true, changed: true, bodyChanged: true }); await second;
  assert.equal(applied, 0); assert.equal(followed, 0);
  busy = false;
  // The completed same-source catalog must not be lost when a chooser is cancelled.
  await live.tick();
  assert.equal(applied, 1); assert.equal(followed, 1);
});


test('a user search is not silently ignored while a background poll is pending', async () => {
  const h = setup(); let release;
  h.api.syncCodexConversation = () => new Promise(resolve => { release = resolve; });
  const poll = h.live.tick();
  await h.live.search('needle', 'all');
  release({ ok: false, reason: 'cancelled' }); await poll;
  assert.equal(h.calls.search, 1);
  assert.match(h.elements.status.textContent, /搜索完成/);
});

test('scrolling away from latest during a poll prevents a late automatic jump', async () => {
  const h = setup(); let release;
  h.setFollowing(true);
  h.api.syncCodexConversation = () => new Promise(resolve => { release = resolve; });
  const poll = h.live.tick(); h.setFollowing(false);
  release({ ok: true, changed: false, bodyChanged: true }); await poll;
  assert.equal(h.calls.latest, 0);
  assert.equal(h.elements.latest.hidden, false);
});

test('search pages replace bounded results, retain the query, and reject late source results', async () => {
  const document=makeFakeDocument(), make=document.createElement;
  document.createElement=tag=>{const el=make(tag);el.listeners={};el.addEventListener=(n,f)=>{el.listeners[n]=f;};return el;};
  const elements=Object.fromEntries(['root','form','input','scope','results','status','cancel','latest'].map(n=>[n,document.createElement('div')]));
  let source='a',release,token;
  const app={isBusy:()=>false,getState:()=>({sourceMode:'folder',folder:{sourceId:source}})};
  const live=createCodexLive({document,elements,app,api:{
    searchCodexConversations:async()=>({ok:true,hits:[{title:'First',snippet:'first'}],nextToken:'next',hasMore:true,searched:0,total:1}),
    moreCodexSearch:t=>{token=t;return new Promise(r=>{release=r;});},
  }});
  await live.search('needle','all');assert.equal(elements.results.children.length,2);
  elements.results.children[1].listeners.click();assert.equal(token,'next');source='b';
  release({ok:true,hits:[{title:'Stale',snippet:'old'}],shown:2,complete:true});
  await new Promise(r=>setImmediate(r));assert.equal(elements.results.children.length,0);
});

test('the first unchanged automatic poll preserves a search started immediately after choosing a source',async()=>{
 const h=setup();h.setSync({ok:true,changed:false});
 h.api.searchCodexConversations=async()=>({ok:true,hits:[],complete:true,searched:1,total:1});
 await h.live.search('needle','all');const text=h.elements.status.textContent;
 await h.live.tick();assert.equal(h.elements.status.textContent,text);
});
