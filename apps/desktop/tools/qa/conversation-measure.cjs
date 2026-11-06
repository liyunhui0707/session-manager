'use strict';
// Each fixture writer exits before a fresh scanner process starts. No real data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const pair = ['user','assistant'].map(role => JSON.stringify({ type:'response_item', payload:{ type:'message',role,
  phase:role==='assistant'?'final_answer':undefined,content:[{type:'input_text',text:`${role} synthetic needle 中文 `+'Readable text. '.repeat(128)}] } })+'\n').join('');
const block=Buffer.from(pair.repeat(128));
async function main() {
  const [mode,file,size,format] = process.argv.slice(2);
  if(mode==='fixture') {
    const input=Readable.from((function*(){for(let i=0;i<Number(size);i++)yield block;})());
    const output=fs.createWriteStream(file,{flags:'wx',mode:0o600});
    if(format==='zstd') await pipeline(input,require('node:zlib').createZstdCompress(),output);
    else await pipeline(input,output);
    return;
  }
  if(mode==='measure') {
    const { createConversationReader }=require('../../lib/codex-page-reader-v2');
    const reader=createConversationReader(),source={filePath:file,canonicalRoot:path.dirname(file),name:'Synthetic'};
    const baselineRssBytes=process.memoryUsage().rss; let peakRssBytes=baselineRssBytes;
    const timer=setInterval(()=>{peakRssBytes=Math.max(peakRssBytes,process.memoryUsage().rss);},2);
    try {
      let at=performance.now(); const latest=await reader.open(source); const latestMs=performance.now()-at;
      const expectedMessages=Number(size)*256;
      assert.equal(latest.page.pages,Math.ceil(expectedMessages/100));
      assert.equal(latest.conversation.messages.length,expectedMessages%100||100);
      assert.equal(latest.page.hasNext,false);
      const retainedRssBytes=process.memoryUsage().rss;
      at=performance.now(); await reader.move(latest.page.readerId,'previous'); const previousMs=performance.now()-at;
      at=performance.now(); await reader.move(latest.page.readerId,'previous'); const secondPreviousMs=performance.now()-at;
      at=performance.now(); await reader.move(latest.page.readerId,'next'); const revisitMs=performance.now()-at;
      const navigationWork=reader.getReadStats();
      assert.deepEqual(navigationWork,{scans:1,validations:3});
      at=performance.now(); await reader.open(source,{page:Math.floor(latest.page.pages/2)}); const distantMs=performance.now()-at;
      const distantWork=reader.getReadWork();
      at=performance.now(); const search=await reader.search(source,'needle'); const searchMs=performance.now()-at;
      assert.equal(search.count,expectedMessages); assert.equal(search.matches.length,200); assert.equal(search.moreMatches,true);
      at=performance.now(); const repeat=await reader.search(source,'needle',{offset:200}); const repeatSearchMs=performance.now()-at;
      assert.equal(repeat.matches.length,200);
      const cache=reader.getCacheUsage();
      at=performance.now(); const pending=reader.open(source);
      const rejection=pending.then(()=>{throw Error('cancel unexpectedly resolved');},error=>{assert.equal(error.code,'READ_CANCELLED');return performance.now()-at;});
      await reader.cancel(); const cancellationClosureMs=performance.now()-at,cancellationRejectionMs=await rejection;
      peakRssBytes=Math.max(peakRssBytes,process.resourceUsage().maxRSS*1024);
      console.log(JSON.stringify({node:process.version,format,storedBytes:fs.statSync(file).size,decodedBytes:Number(size)*block.length,
        expectedMessages,pages:latest.page.pages,baselineRssBytes,peakRssBytes,retainedRssBytes,latestMs,previousMs,secondPreviousMs,revisitMs,navigationWork,distantMs,distantWork,searchMs,repeatSearchMs,cache,cancellationRejectionMs,cancellationClosureMs}));
    } finally {clearInterval(timer);await reader.close();}
    return;
  }
  assert.equal(Number(process.versions.node.split('.')[0]),24);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'asm-conversation-measure-'))),results=[];
  const run=args=>{const r=spawnSync(process.execPath,[__filename,...args],{encoding:'utf8',timeout:180000,maxBuffer:65536});if(r.status!==0||r.error||r.signal)throw Error('Synthetic worker failed: '+r.stderr.slice(-1500));return r.stdout;};
  async function fingerprint(file) {const s=fs.statSync(file,{bigint:true}),h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return JSON.stringify([String(s.mode),String(s.size),String(s.mtimeNs),h.digest('hex')]);}
  for(const format of ['raw','zstd'])for(const size of [64,256,1024]) {
    const file=path.join(root,`rollout-${format}-${size}.jsonl`+(format==='zstd'?'.zst':'')),blocks=Math.ceil(size*1024*1024/block.length);
    run(['fixture',file,String(blocks),format]);const before=await fingerprint(file);
    const result=JSON.parse(run(['measure',file,String(blocks),format])); assert.equal(await fingerprint(file),before);
    results.push({...result,readOnly:true});console.log(JSON.stringify(results.at(-1)));
    fs.unlinkSync(file); // this script's exact temporary synthetic output only
  }
  const report={scope:'One fresh Node 24 run per size/format. RSS includes worker threads; excludes Electron, renderer and native catalog helper. Timing has no repeated-run variance estimate.',results};
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log('Evidence: '+root);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
