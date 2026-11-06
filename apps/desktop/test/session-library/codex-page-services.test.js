'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSourceState } = require('../../lib/session-source-state');
const { registerConversationServices } = require('../../lib/codex-page-services');
const id = '11111111-1111-4111-8111-111111111111';
function harness(searchResult = {}) {
  const state = createSessionSourceState(() => true), handlers = new Map();
  let entries = [{ entryId: id, sessionId: 'synthetic', area: 'active', title: 'Before', filePath: '/synthetic/rollout-a.jsonl', canonicalRoot: '/synthetic', bytes: 100, updatedAt: 1 }];
  const catalog = () => ({ canonicalRoot: '/synthetic', sourceId: 'test', layout: 'full', titleIndexState: 'loaded', entries, diagnostics: {} });
  state.commitFolderScan(state.beginFolderScan('/synthetic'), catalog()); state.selectFolderEntry(id);
  let bound, opened;
  const reader = { rebind: e => { bound = e; }, getSource: () => bound, open: async (source, options) => { opened = { source, options }; return { name: source.name }; }, cancel: async () => true };
  registerConversationServices(state.guard({ handle: (n, h) => handlers.set(n, h) }), {
    sourceState: state, reader, scanSource: async () => catalog(),
    searchReader: { search: async () => ({ matches: [{ page: 2, message: 1, snippet: 'Found' }], moreMatches: false, ...searchResult }), cancel: async () => true },
  });
  return { state, call: (name, ...args) => handlers.get(name)({}, ...args), set: next => { entries = next; }, entries,
    get bound() { return bound; }, get opened() { return opened; } };
}
test('automatic sync retains identity on unchanged polls, rebinds names and removes archived selection', async () => {
  const h = harness(), before = h.state.getFolderCatalog();
  const same = await h.call('codexConversation:sync');
  assert.equal(same.changed, false); assert.equal(h.state.getFolderCatalog().generation, before.generation);
  h.set(h.entries.map(e => ({ ...e, title: 'Renamed', entryId: '22222222-2222-4222-8222-222222222222' })));
  const renamed = await h.call('codexConversation:sync');
  assert.equal(renamed.changed, true); assert.equal(renamed.bodyChanged, false);
  assert.equal(h.bound.name, 'Renamed');
  h.set([]); const archived = await h.call('codexConversation:sync');
  assert.equal(archived.catalog.entries.length, 0); assert.equal(archived.catalog.selectedEntryId, null);
});
test('search returns opaque hits, opens exact match page and rejects stale hits after sync', async () => {
  const h = harness();
  const result = await h.call('codexConversation:search', 'Found', 'all');
  assert.equal(result.ok, true); assert.equal(result.complete, true);
  assert.equal(JSON.stringify(result).includes('/synthetic'), false);
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0]; assert.ok(hit.hitId); assert.equal(hit.page, undefined);
  assert.equal((await h.call('codexConversation:open-hit', hit.hitId)).ok, true);
  assert.equal(h.opened.options.page, 2);
  assert.equal((await h.call('codexConversation:search', 'Found', '../../escape')).ok, false);
  h.set([]); await h.call('codexConversation:sync');
  assert.equal((await h.call('codexConversation:open-hit', hit.hitId)).ok, false);
});
test('service disposal cancels an ongoing search and rejects further work', async () => {
  const state = createSessionSourceState(() => true), handlers = new Map();
  let finish, cancelled = 0;
  const service = registerConversationServices(state.guard({ handle: (n, h) => handlers.set(n, h) }), {
    sourceState: state, reader: { getSource: () => ({ filePath: '/synthetic/rollout.jsonl' }) },
    searchReader: { search: () => new Promise(resolve => { finish = resolve; }), cancel: async () => {
      cancelled++; finish({ matches: [], moreMatches: false });
    } },
  });
  const pending = handlers.get('codexConversation:search')({}, 'needle', 'current');
  await service.dispose();
  const result = await pending;
  assert.equal(cancelled, 1); assert.equal(result.cancelled, true); assert.equal(result.complete, false);
  assert.equal((await handlers.get('codexConversation:search')({}, 'needle', 'current')).ok, false);
});

test('search preserves observed hits but marks omitted content as incomplete', async () => {
  const h = harness({ incomplete: true });
  const result = await h.call('codexConversation:search', 'Found', 'all');
  assert.equal(result.hits.length, 1);
  assert.equal(result.searched, 1);
  assert.equal(result.complete, false);
  assert.equal(result.partialConversations, 1);
});

test('search pagination crosses sessions without losing hits and invalidates old tokens and changed snapshots', async () => {
  const state=createSessionSourceState(()=>true),handlers=new Map(),calls=[];
  const entries=[1,2].map(n=>({entryId:`11111111-1111-4111-8111-11111111111${n}`,sessionId:`s${n}`,area:'active',title:`S${n}`,filePath:`/synthetic/${n}`,canonicalRoot:'/synthetic'}));
  state.commitFolderScan(state.beginFolderScan('/synthetic'),{canonicalRoot:'/synthetic',sourceId:'s',layout:'full',entries,diagnostics:{}});
  let changed=false;
  registerConversationServices(state.guard({handle:(n,h)=>handlers.set(n,h)}),{sourceState:state,reader:{getSource:()=>null},searchReader:{
    async search(source,q,{offset,limit}) {
      calls.push({source,offset,limit}); if(changed&&source.snapshot)throw Object.assign(Error(),{code:'SOURCE_CHANGED'});
      const n=source.sessionId==='s1'?250:80, end=Math.min(n,offset+limit);
      return{matches:Array.from({length:end-offset},(_,i)=>({page:0,message:i,snippet:`${source.sessionId}:${i+offset}`})),moreMatches:end<n,snapshot:{size:1}};
    },cancel:async()=>true,
  }});
  const call=(n,...a)=>handlers.get(`codexConversation:${n}`)({},...a);
  const first=await call('search','needle','all');assert.equal(first.hits.length,200);assert.equal(first.hasMore,true);
  assert.equal((await call('search-more','not-a-token')).ok,false);
  const second=await call('search-more',first.nextToken);assert.equal(second.hits.length,130);assert.equal(second.complete,true);
  assert.equal(new Set([...first.hits,...second.hits].map(h=>h.snippet)).size,330);
  assert.equal((await call('search-more',first.nextToken)).ok,false);
  assert.deepEqual(calls[1].source.snapshot,{size:1});
  assert.equal((await call('open-hit',first.hits[0].hitId)).ok,false);
  const third=await call('search','needle','all');changed=true;
  assert.equal((await call('search-more',third.nextToken)).reason,'stale-result');
});
