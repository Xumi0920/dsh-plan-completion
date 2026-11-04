// Performance of local history processing; no network/model inference by default.
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {longSessionFixture} from '../support/long-session-fixture.js';
const rootArg=process.argv.slice(2).find(v=>!v.startsWith('--'));
const moduleRoot=rootArg ? pathToFileURL(resolve(rootArg)+'/') : new URL('../',import.meta.url);
const {collectRetrievalRecords}=await import(new URL('host/rag-evidence.js',moduleRoot));
const {collectFromEvents}=await import(new URL('host/evidence.js',moduleRoot));
const {createRag}=await import(new URL('host/rag.js',moduleRoot));
const fixture=longSessionFixture();
const rss0=process.memoryUsage().rss;
const rows=[];
const rag=createRag({enabled:true},{client:{async embed(texts){return texts.map(()=>{const v=new Float32Array(1024);v[0]=1;return v;});},close(){}}});
try {
  const boundaries=process.argv.includes('--all-steps')
    ? fixture.events.filter(e=>e.type==='step/end'||e.type==='compaction/end').map(e=>e.seq+1)
    : fixture.boundaries;
  for(const end of boundaries){
    const events=fixture.events.slice(0,end);
    const turn=events.at(-1).data.turn;
    const before=performance.now();
    collectRetrievalRecords('load',events,{maxRecords:32768});
    rag.sync('load',events);
    collectFromEvents({events,turn});
    const scanMs=performance.now()-before;
    await rag.idle();
    rows.push({turn,events:events.length,scanMs,records:rag.stats().records});
  }
  const samples=rows.map(r=>r.scanMs).sort((a,b)=>a-b);
  console.log(JSON.stringify({kind:'synthetic local history processing; deterministic fake embeddings; not 1M token inference',turns:fixture.turns,steps:fixture.steps,
    events:fixture.events.length,measuredBoundaries:boundaries.length,serializedBytes:Buffer.byteLength(JSON.stringify(fixture.events)),
    scanMedianMs:samples[Math.floor(samples.length/2)],scanP95Ms:samples[Math.ceil(samples.length*.95)-1],scanMaxMs:samples.at(-1),
    totalScanMs:rows.reduce((a,r)=>a+r.scanMs,0),rssDeltaMiB:(process.memoryUsage().rss-rss0)/2**20,
    records:rag.stats().records,firstConstraintRetained:rag.records('load').some(r=>r.seq===1),rows},null,2));
}finally{rag.close();}
