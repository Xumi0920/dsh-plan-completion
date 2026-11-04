import {test} from 'node:test';
import assert from 'node:assert/strict';
import {complexFixtures} from '../support/complex-fixtures.js';
import {createRag} from '../host/rag.js';
import {targetCoverage} from '../host/retrieval-policy.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {validateProgress} from '../host/progress.js';
const fixtures=complexFixtures(),get=name=>fixtures.find(f=>f.name===name);
const ids=r=>r.targets.groups.flatMap(g=>g.checks.map(c=>c.receiptId).filter(Boolean));
const proposal=(f,evidence)=>({op:'patch',changes:f.plan.steps.map(s=>({id:s.id,status:'done',evidence}))});

test('six-step task retains all 14 receipt pointers despite semantic topK=1',async t=>{
 const f=get('qq-complete'),rag=createRag({enabled:true,strategy:'typed',topK:1,contextChars:200},{client:{async embed(ts){return ts.map(()=>Float32Array.from([1,0]));},close(){}}});t.after(()=>rag.close());
 rag.sync(f.sessionId,f.events);await rag.idle();const r=await rag.retrieve(f.sessionId,f.query,{purpose:'mixed',completions:f.plan.steps.map(s=>s.completion)});
 assert.equal(r.records.length,1);assert.equal(ids(r).length,14);assert.equal(r.targets.incomplete,false);
 const checked=validateProgress(proposal(f,ids(r)),f.plan,rag.records(f.sessionId));
 assert.deepEqual(checked.output.changes.map(s=>s.status),f.expected);
});
test('latest failure, stale verification, missing receipt, wrong identity and recovery remain guarded',()=>{
 for(const f of fixtures) {
  const records=collectRetrievalRecords(f.sessionId,f.events),targets=targetCoverage(records,f.plan.steps.map(s=>s.completion));
  const checked=validateProgress(proposal(f,ids({targets})),f.plan,records);
  assert.deepEqual(checked.output.changes.map(s=>s.status),f.expected,f.name);
 }
});
test('truncation omits whole groups with an explicit incomplete flag, never incomplete IDs',()=>{
 const f=get('workflow-complete'),records=collectRetrievalRecords(f.sessionId,f.events);
 const r=targetCoverage(records,f.plan.steps.map(s=>s.completion),{maxChars:1400});
 assert.ok(JSON.stringify(r).length<=1400);assert.equal(r.incomplete,true);assert.ok(r.omitted>0);
 for(const g of r.groups)assert.equal(g.checks.length,(f.plan.steps[g.completionIndex].completion.all??[1]).length);
 assert.notDeepEqual(validateProgress(proposal(f,ids({targets:r})),f.plan,records).output.changes.map(s=>s.status),f.expected);
});
test('coverage carries neither arbitrary receipt payloads nor private arguments or raw facts',()=>{
 const f=get('qq-complete'),records=collectRetrievalRecords(f.sessionId,f.events);
 for(const r of records){r.text='PRIVATE-BODY-CANARY';if(r.kind==='tool_result')r.facts.secret='PRIVATE-FACT-CANARY';}
 const text=JSON.stringify(targetCoverage(records,f.plan.steps.map(s=>s.completion)));
 assert.doesNotMatch(text,/PRIVATE-|room-demo|image-client/);assert.ok(text.length<=12000);
});
test('offline fallback keeps target coverage, purpose filtering excludes it from intent lookup, forget clears it',async t=>{
 const f=get('workflow-complete'),rag=createRag({enabled:true,strategy:'typed'},{client:{async embed(){throw Error('offline');},close(){}}});t.after(()=>rag.close());
 rag.sync(f.sessionId,f.events);await rag.idle();const opts={completions:f.plan.steps.map(s=>s.completion)};
 const r=await rag.retrieve(f.sessionId,f.query,{...opts,purpose:'mixed'});assert.equal(r.mode,'lexical');assert.equal(ids(r).length,14);
 assert.equal((await rag.retrieve(f.sessionId,'英文思考',{...opts,purpose:'intent'})).targets,undefined);
 rag.forget(f.sessionId);assert.equal((await rag.retrieve(f.sessionId,f.query,opts)).targets,undefined);
});
test('coverage readiness includes fact matching and order, without asserting business completion',()=>{
 for(const [name,index,ready] of [['qq-complete',0,true],['qq-stale',1,false],['qq-failed',2,false],['qq-unknown',4,false],['qq-recovered',2,true],['qq-weak-contract',4,false]]) {
  const f=get(name),records=collectRetrievalRecords(f.sessionId,f.events);
  const coverage=targetCoverage(records,f.plan.steps.map(s=>s.completion));
  assert.equal(coverage.groups[index].receiptReady,ready,name);
 }
 // An unscoped acknowledgement is deliberately NOT a business verdict.
 const weak=get('qq-weak-contract');assert.equal(weak.expected[4],'doing');
});
test('acknowledgement needs an explicit acceptance scope; legitimate submission remains possible',()=>{
 for(const result of [{ok:true,accepted:true},{ok:true,status:'submitted'},{ok:true,state:'accepted'}]) {
  const f=get('qq-weak-contract'),events=[{seq:1,type:'tool/call',data:{turn:1,callId:'a',name:'submit_delivery',arguments:{task:'image-A',room:'room-demo'}}},
   {seq:2,type:'tool/result',data:{turn:1,message:{toolCallId:'a',content:[{type:'text',text:JSON.stringify(result)}]}}}];
  const records=collectRetrievalRecords(f.sessionId,events),evidence=records.filter(r=>r.kind==='tool_result').map(r=>r.id);
  assert.equal(validateProgress(proposal(f,evidence),f.plan,records).output.changes[4].status,'doing');
  const plan=structuredClone(f.plan);plan.steps[4].title='提交指定请求';
  plan.steps[4].completion.expect=Object.hasOwn(result,'accepted')?{field:'accepted',equals:true}:Object.hasOwn(result,'status')?{field:'status',equals:'submitted'}:{field:'state',equals:'accepted'};
  assert.equal(validateProgress(proposal(f,evidence),plan,records).output.changes[4].status,'done');
  plan.steps[4].title='确认指定图像送达';plan.steps[4].completion.expect={field:'delivered',equals:true};
  assert.equal(validateProgress(proposal(f,evidence),plan,records).output.changes[4].status,'doing');
 }
});
test('maximum seven by six checklist stays bounded with explicit omissions, and session pointers cannot leak',async t=>{
 const f=get('qq-complete'),records=collectRetrievalRecords(f.sessionId,f.events);
 const coverage=targetCoverage(records,Array.from({length:7},()=>f.plan.steps[0].completion));
 assert.ok(JSON.stringify(coverage).length<=12000);
 assert.equal(coverage.groups.reduce((n,g)=>n+g.checks.length,0)+coverage.omitted*6,42);
 const rag=createRag({enabled:true,strategy:'typed'},{client:{async embed(ts){return ts.map(()=>Float32Array.from([1,0]));},close(){}}});t.after(()=>rag.close());
 rag.sync(f.sessionId,f.events);rag.sync('empty-session',[]);await rag.idle();
 const r=await rag.retrieve('empty-session','检查完成',{purpose:'mixed',completions:f.plan.steps.map(s=>s.completion)});
 assert.equal(ids(r).length,0);assert.ok(r.targets.groups.every(g=>!g.receiptReady));
});
