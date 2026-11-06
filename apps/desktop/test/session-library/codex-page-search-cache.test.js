'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createConversationReader}=require('../../lib/codex-page-reader-v2');
test('paged search reaches all hits, reuses bounded results, and invalidates modified sources',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'asm-search-pages-'))),file=path.join(root,'rollout-search.jsonl');
 const row=i=>JSON.stringify({type:'event_msg',payload:{type:'user_message',message:`needle ${i}`}})+'\n';
 await fs.writeFile(file,Array.from({length:1250},(_,i)=>row(i)).join(''));
 const source={filePath:file,canonicalRoot:root,name:'Search'},reader=createConversationReader();
 t.after(async()=>{await reader.close();await fs.rm(root,{recursive:true,force:true});});
 let offset=0,seen=[];
 for(let p=0;p<7;p++){
  const result=await reader.search(source,'needle',{offset});seen.push(...result.matches.map(m=>m.snippet));
  assert.equal(result.totalMatches,1250);offset=result.nextOffset;
  if(p===1)assert.deepEqual(reader.getReadStats(),{scans:1,validations:1});
 }
 assert.equal(offset,null);assert.equal(seen.length,1250);assert.equal(new Set(seen).size,1250);
 const repeat=await reader.search(source,'needle',{offset:1000});assert.equal(repeat.matches.length,200);
 const scans=reader.getReadStats().scans;
 assert.equal((await reader.search(source,'needle',{offset:0})).matches[0].snippet,'needle 0');
 assert.equal(reader.getReadStats().scans,scans,'return to first retained search window must not rescan');
 await fs.writeFile(file,row('changed'));
 const changed=await reader.search(source,'needle');assert.equal(changed.totalMatches,1);assert.match(changed.matches[0].snippet,/changed/);
 for(let i=0;i<10;i++)await reader.search(source,`query-${i}`);
 const usage=reader.getCacheUsage();assert.ok(usage.searchEntries<=4);assert.ok(usage.searchBytes<=4*1024**2);
 await reader.close();assert.equal(reader.getCacheUsage().searchBytes,0);
});

test('cached search validates source ancestry and explicit snapshots, and cancellation cannot repopulate a closed reader',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'asm-search-validation-'))),file=path.join(root,'rollout-search.jsonl');
 const row=JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'needle'}})+'\n';
 await fs.writeFile(file,row);const reader=createConversationReader(),source={filePath:file,canonicalRoot:root};
 t.after(async()=>{await reader.close();await fs.rm(root,{recursive:true,force:true});});
 const result=await reader.search(source,'needle');await fs.writeFile(file,row+row);
 await assert.rejects(reader.search({...source,snapshot:result.snapshot},'needle'),{code:'SOURCE_CHANGED'});
 await reader.search(source,'needle');await fs.rename(file,file+'.old');await fs.symlink(file+'.old',file);
 await assert.rejects(reader.search(source,'needle'));
 await fs.unlink(file);await fs.rename(file+'.old',file);
 const pending=reader.search(source,'new-query');const rejected=assert.rejects(pending,{code:'READ_CANCELLED'});
 await reader.close();await rejected;assert.equal(reader.getCacheUsage().searchEntries,0);
});
