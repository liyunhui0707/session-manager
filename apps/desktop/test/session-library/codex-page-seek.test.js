'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createConversationReader}=require('../../lib/codex-page-reader-v2');
const {zstdCompressSync}=require('node:zlib');
const {readConversation}=require('../../lib/codex-page-reader-task');
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'asm-seek-'))),file=path.join(root,'rollout-seek.jsonl');
 const row=(type,message)=>JSON.stringify({type:'event_msg',payload:{type,...(type==='user_message'?{message}:{last_agent_message:message})}})+'\n';
 const data=Array.from({length:20000},(_,i)=>row('user_message',`Question ${i}`)+row('task_complete',`Answer ${i}`)).join('');
 await fs.writeFile(file,data);const reader=createConversationReader();t.after(async()=>{await reader.close();await fs.rm(root,{recursive:true,force:true});});
 return{reader,file,source:{filePath:file,canonicalRoot:root,name:'Synthetic seek'}};
}
test('far raw pages resume from a bounded snapshot index and equal full reads',async t=>{
 const {reader,source}=await fixture(t);await reader.open(source);
 for(const page of [30,5,250,20,0,399]){
  const result=await reader.open(source,{page});const reference=await readConversation({source,page});
  assert.deepEqual(result.conversation,reference.conversation);assert.equal(result.page.pages,reference.pages);
  if(page>=20){assert.equal(reader.getReadWork().indexed,true);assert.ok(reader.getReadWork().parsedRecords<3500);}
 }
 const stats=reader.getCacheUsage();assert.ok(stats.seekBytes<=8*1024**2);assert.ok(stats.seekPoints<=32);
});
test('indexed reads reject a replaced snapshot and a fresh open rebuilds it',async t=>{
 const {reader,source,file}=await fixture(t);const first=await reader.open(source);
 await fs.appendFile(file,'\n');await assert.rejects(reader.move(first.page.readerId,'previous'),{code:'SOURCE_CHANGED'});
 await reader.open(source);const old=reader.getSnapshot();await fs.rename(file,file+'.old');await fs.copyFile(file+'.old',file);
 await assert.rejects(reader.open({...source,snapshot:old},{page:30}),{code:'SOURCE_CHANGED'});
 const current=await reader.open(source,{page:30});assert.ok(current.conversation.messages.length);assert.equal(!!reader.getReadWork().indexed,false);
 await reader.close();assert.deepEqual(reader.getCacheUsage(),{seekPoints:0,seekBytes:0,searchEntries:0,searchBytes:0});
});

test('compressed distant pages decode the prefix but only parse records after a verified checkpoint', async t => {
 const {reader,source,file}=await fixture(t);
 const compressed=file+'.zst';await fs.writeFile(compressed,zstdCompressSync(await fs.readFile(file)));
 const input={...source,filePath:compressed};await reader.open(input);
 for(const page of [30,250,5,399,0]){
  const result=await reader.open(input,{page}),reference=await readConversation({source:input,page});
  assert.deepEqual(result.conversation,reference.conversation);assert.equal(result.page.pages,reference.pages);
  if(page>=20){assert.equal(reader.getReadWork().indexed,true);assert.ok(reader.getReadWork().parsedRecords<3500);}
 }
 const usage=reader.getCacheUsage();assert.ok(usage.seekPoints>0&&usage.seekPoints<=32);assert.ok(usage.seekBytes<=8*1024**2);
 const snapshot=reader.getSnapshot();await fs.writeFile(compressed,zstdCompressSync('changed\n'));
 await assert.rejects(reader.open({...input,snapshot},{page:30}),{code:'SOURCE_CHANGED'});
});
