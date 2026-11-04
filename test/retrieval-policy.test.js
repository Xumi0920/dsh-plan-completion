import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRag} from '../host/rag.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {validateProgress} from '../host/progress.js';
import {abFixtures} from '../support/ab-fixtures.js';

const vector = () => Float32Array.from([1,0]);
const client = {async embed(texts) { return texts.map(vector); },close(){}};
const fixture = name => abFixtures().find(f => f.name === name);
async function withRag(t, f, config={}, dependencies={}) {
 const rag=createRag({enabled:true,strategy:'typed',...config},{client,...dependencies});
 t.after(()=>rag.close());rag.sync(f.sessionId,f.events);await rag.idle();return rag;
}

test('typed Chinese intent queries select original English reasoning, never completion claims',async t=>{
 const f=fixture('intent'),rag=await withRag(t,f);
 const r=await rag.retrieve(f.sessionId,f.query,{purpose:'intent'});
 assert.ok(r.records.length);assert.ok(r.records.every(r=>r.kind==='reasoning_intent'&&!r.completionEligible));
 assert.ok(r.records.some(r=>f.goldSeqs.includes(r.seq)));
});
test('typed evidence anchors the latest exact-target failure ahead of optimistic similar claims',async t=>{
 const f=fixture('latest-failure'),rag=await withRag(t,f);
 const r=await rag.retrieve(f.sessionId,f.query,{purpose:'evidence',completions:[f.plan.steps[0].completion]});
 assert.ok(r.records.every(r=>['tool_call','tool_result'].includes(r.kind)));
 assert.ok(r.records.some(r=>f.goldSeqs.includes(r.seq)&&r.outcome==='failure'));
 const checked=validateProgress({op:'patch',changes:[{id:'s1',status:'done',evidence:r.records.map(r=>r.id)}]},f.plan,rag.records(f.sessionId));
 assert.equal(checked.output.changes[0].status,'blocked');
});
test('mandatory receipt lookup does not substitute unrelated paths or another session',async t=>{
 const f=fixture('unrelated'),rag=await withRag(t,f);
 const other=fixture('verified');rag.sync(other.sessionId,other.events);await rag.idle();
 const r=await rag.retrieve(f.sessionId,'no lexical overlap',{purpose:'evidence',completions:[f.plan.steps[0].completion]});
 assert.ok(r.records.every(r=>r.sessionId===f.sessionId));
 assert.ok(!r.records.some(r=>r.kind==='tool_result'&&r.tool==='read_file'));
 assert.equal(validateProgress({op:'patch',changes:[{id:'s1',status:'done',evidence:r.records.map(r=>r.id)}]},f.plan,rag.records(f.sessionId)).output.changes[0].status,'todo');
});
test('query cache separates retrieval purposes and reuses the identical query/purpose',async t=>{
 const seen=[],f=fixture('intent');
 const rag=await withRag(t,f,{}, {client:{async embed(texts){seen.push(...texts.filter(t=>t.startsWith('Instruct:')));return texts.map(vector);},close(){}}});
 await rag.retrieve(f.sessionId,'缓存',{purpose:'intent'});
 await rag.retrieve(f.sessionId,'缓存',{purpose:'evidence'});
 await rag.retrieve(f.sessionId,'缓存',{purpose:'intent'});
 assert.equal(seen.length,2);assert.notEqual(seen[0],seen[1]);
});
test('offline typed lookup retains original constraints and receipt anchors within limits',async t=>{
 const f=fixture('verified'),rag=await withRag(t,f,{topK:2,contextChars:200},{client:{async embed(){throw Error('offline');},close(){}}});
 const r=await rag.retrieve(f.sessionId,f.query,{purpose:'evidence',completions:[f.plan.steps[0].completion]});
 assert.equal(r.mode,'lexical');assert.ok(r.records.length<=2);assert.ok(r.records.reduce((n,r)=>n+r.text.length,0)<=200);
 assert.match(JSON.stringify(r.constraints),/禁止修改生产配置/);
 // Limited context cannot certify the omitted second receipt.
 assert.notEqual(validateProgress({op:'patch',changes:[{id:'s1',status:'done',evidence:r.records.map(r=>r.id)}]},f.plan,rag.records(f.sessionId)).output.changes[0].status,'done');
});
test('three background failures cool down and a later query restarts indexing without new history',async t=>{
 let at=0,offline=true,calls=0;
 const f=fixture('intent'),rag=await withRag(t,f,{}, {now:()=>at,client:{async embed(texts){calls++;if(offline)throw Error('offline');return texts.map(vector);},close(){}}});
 for(const time of [1100,2200]){at=time;rag.sync(f.sessionId,f.events);await rag.idle();}
 assert.equal(calls,3);at=3000;await rag.retrieve(f.sessionId,f.query);await rag.idle();assert.equal(calls,3);
 offline=false;at=33000;await rag.retrieve(f.sessionId,f.query);await rag.idle();
 assert.ok(rag.stats().vectors>0);assert.equal((await rag.retrieve(f.sessionId,f.query)).mode,'hybrid');
});
test('forget cancels an in-flight embedding and its completion cannot resurrect a session',async t=>{
 let release;const f=fixture('intent');
 const rag=createRag({enabled:true,strategy:'typed'},{client:{embed:texts=>new Promise(resolve=>{release=()=>resolve(texts.map(vector));}),close(){}}});t.after(()=>rag.close());
 rag.sync(f.sessionId,f.events);await Promise.resolve();assert.ok(release);
 rag.forget(f.sessionId);release();await rag.idle();assert.equal(rag.stats().sessions,0);
 assert.equal((await rag.retrieve(f.sessionId,f.query)).records.length,0);
});
test('structured receipt facts are scalar, bounded and redacted before indexing',()=>{
 const events=[{seq:1,type:'tool/call',data:{turn:1,callId:'x',name:'read_file',arguments:{path:'a'}}},
 {seq:2,type:'tool/result',data:{turn:1,message:{toolCallId:'x',content:[{type:'text',text:JSON.stringify({ok:true,content:'password=do-not-expose',password:'private-value',nested:{secret:'x'},huge:'x'.repeat(500)})}]}}}];
 const r=collectRetrievalRecords('a',events).find(r=>r.kind==='tool_result');
 assert.equal(r.facts.password,'[REDACTED]');assert.equal(r.facts.huge,undefined);assert.equal(r.facts.nested,undefined);
 assert.doesNotMatch(JSON.stringify(r),/do-not-expose|private-value/);
});
