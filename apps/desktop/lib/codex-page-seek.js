'use strict';
const {makeCheckpoint}=require('./codex-page-append');
const SEEK_BYTES=8*1024**2, SEEK_POINTS=32;
// Adaptive sparse checkpoints, owned by one selected source. This is a payload
// budget, not an RSS limit. Thinning increases scan distance rather than memory.
function createSeekIndex(saved){
 let points=saved?.points?.slice()||[],stride=saved?.stride||8;
 let bytes=points.reduce((n,p)=>n+p.size,0);
 return{
  consider(page,offset,records,state){
   if(page<(points.at(-1)?.state.page||0)+stride)return;
   const point=makeCheckpoint({offset,records},state());if(!point)return;
   point.size=Buffer.byteLength(JSON.stringify(point))+32;points.push(point);bytes+=point.size;
   while(points.length>SEEK_POINTS||bytes>SEEK_BYTES){
    points=points.filter((_,i)=>i%2===0);stride*=2;bytes=points.reduce((n,p)=>n+p.size,0);
   }
  },
  snapshot:()=>({points,stride,bytes}),
 };
}
const findSeek=(index,page)=>index?.points?.findLast(point=>point.state.page<page);
module.exports={createSeekIndex,findSeek,SEEK_BYTES,SEEK_POINTS};
