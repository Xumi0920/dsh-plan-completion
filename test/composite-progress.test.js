import { test } from 'node:test';
import assert from 'node:assert/strict';

test('redacted or secret-bearing targets cannot collapse into a shared acceptance identity',()=>{
 for(const args of [{password:'one'},{path:'password=secret-value'},{path:'[REDACTED]'},{offset:Infinity},{offset:NaN}])
  assert.equal(normalizeCompletion({tool:'read_file',args}),undefined);
});
import { collectRetrievalRecords } from '../host/rag-evidence.js';
import { normalizeCompletion, validateProgress, lifecycleChanges } from '../host/progress.js';
import { normalizePlan, patchPlan } from '../host/plan.js';
import { buildPatchPrompt, parseModelOutput } from '../host/prompt.js';

const write={tool:'write_file',args:{path:'src/cache.ts'}};
const read={tool:'read_file',args:{path:'src/cache.ts'},expect:{field:'content',equals:'expected'}};
const plan=(completion={all:[write,read]})=>({sessionId:'composite',steps:[{id:'s1',title:'写入并回读校验缓存',status:'todo',completion},{id:'s2',title:'报告',status:'todo'},{id:'s3',title:'交付',status:'todo'}]});
const events=[];
function execution(tool,args,result,turn=1){const seq=events.length;events.push({seq,type:'tool/call',data:{turn,callId:'c'+seq,name:tool,arguments:args}});if(result!==undefined)events.push({seq:seq+1,type:'tool/result',data:{turn,message:{toolCallId:'c'+seq,content:[{type:'text',text:JSON.stringify(result)}]}}});}
function checked(base=plan(),citations){const records=collectRetrievalRecords(base.sessionId,events);const evidence=citations??records.filter(r=>r.kind==='tool_result').map(r=>r.id);return validateProgress({op:'patch',changes:[{id:'s1',status:'done',evidence}]},base,records).output.changes[0];}

test('legacy composite cannot be completed or grandfathered from a write receipt',()=>{
 events.length=0;execution('write_file',write.args,{ok:true});
 const base=plan(write);assert.equal(checked(base).lifecycle,'acceptance_missing');assert.notEqual(checked(base).status,'done');
 Object.assign(base.steps[0],{status:'done',lifecycle:'verified_receipt',evidence:collectRetrievalRecords(base.sessionId,events).filter(r=>r.kind==='tool_result').map(r=>r.id)});
 assert.notEqual(lifecycleChanges(base,collectRetrievalRecords(base.sessionId,events))[0].status,'done');
});
test('all acceptance receipts must succeed, match expected content and be cited',()=>{
 events.length=0;execution('write_file',write.args,{ok:true});assert.equal(checked().lifecycle,'acceptance_partial');
 execution('read_file',read.args,{ok:true,content:'expected'});assert.equal(checked().status,'done');
 const receipts=collectRetrievalRecords('composite',events).filter(r=>r.kind==='tool_result');assert.notEqual(checked(plan(),[receipts[0].id]).status,'done');
});
test('successful read with wrong content fails acceptance; missing content stays unverified',()=>{
 events.length=0;execution('write_file',write.args,{ok:true});execution('read_file',read.args,{ok:true,content:'wrong'});
 assert.equal(checked().status,'blocked');assert.equal(checked().lifecycle,'acceptance_failed');
 events.splice(2);execution('read_file',read.args,{ok:true});assert.equal(checked().lifecycle,'outcome_unverified');
});
test('new mutation invalidates earlier verification and restored done state',()=>{
 events.length=0;execution('write_file',write.args,{ok:true});execution('read_file',read.args,{ok:true,content:'expected'});
 const base=plan();Object.assign(base.steps[0],checked());execution('write_file',write.args,{ok:true},2);
 assert.equal(checked(base).lifecycle,'verification_stale');assert.equal(checked(base).status,'doing');
 execution('read_file',read.args,{ok:true,content:'expected'},2);assert.equal(checked(base).status,'done');
});
test('any latest failure, interrupted call or pending receipt prevents composite completion',()=>{
 for(const scenario of ['failed','pending','interrupted']){
  events.length=0;execution('write_file',write.args,{ok:true});execution('read_file',read.args,scenario==='pending'?undefined:{ok:scenario!=='failed',content:'expected'});
  if(scenario==='interrupted')events.push({seq:events.length,type:'turn/end',data:{turn:1,reason:{kind:'interrupted'}}});
  assert.equal(checked().status,scenario==='pending'?'doing':'blocked');
 }
});
test('one receipt cannot satisfy overlapping criteria and same-update target replacement is rejected',()=>{
 events.length=0;execution('write_file',{path:'src/cache.ts',content:'expected'},{ok:true});
 assert.notEqual(checked(plan({all:[write,{tool:'write_file',args:{path:'src/cache.ts',content:'expected'}}]})).status,'done');
 const base=plan();const records=collectRetrievalRecords(base.sessionId,events);
 const out=validateProgress({op:'patch',changes:[{id:'s1',status:'done',completion:write,evidence:[records.at(-1).id]}]},base,records).output.changes[0];
 assert.deepEqual(out.completion,base.steps[0].completion);assert.notEqual(out.status,'done');
});
test('invalid or duplicate acceptance arrays fail closed rather than dropping invalid criteria',()=>{
 for(const all of [[write],[write,write],[write,{}],[write,{all:[write,read]}],Array(7).fill(write)])assert.equal(normalizeCompletion({all}),undefined);
 assert.equal(normalizeCompletion({...write,all:[write,read]}),undefined);
 assert.equal(normalizeCompletion({...read,expect:{field:'content',equals:'[REDACTED]'}}),undefined);
});
test('renaming and deleting a criterion cannot weaken an existing step; strengthening needs a later review',()=>{
 events.length=0;execution('write_file',write.args,{ok:true});
 const records=collectRetrievalRecords('composite',events), base=plan();
 const attempt={op:'patch',changes:[{id:'s1',title:'只写入',completion:write,status:'done',evidence:[records.at(-1).id]}]};
 const out=validateProgress(attempt,base,records).output.changes[0];
 assert.equal(out.title,base.steps[0].title);assert.deepEqual(out.completion,base.steps[0].completion);assert.notEqual(out.status,'done');
 execution('read_file',read.args,{ok:true,content:'expected'});
 const all=collectRetrievalRecords('composite',events);const upgraded=validateProgress({op:'patch',changes:[{id:'s1',completion:base.steps[0].completion,status:'done',evidence:all.filter(r=>r.kind==='tool_result').map(r=>r.id)}]},plan(write),all).output.changes[0];
 assert.deepEqual(upgraded.completion,base.steps[0].completion);assert.notEqual(upgraded.status,'done');
 const persisted=patchPlan(plan(write),[upgraded],{reason:'stronger acceptance'}).plan;
 assert.equal(checked(persisted).status,'done');
});
test('checklists and expectations survive parsing, persistence normalization and title migration',()=>{
 const p=plan();const parsed=parseModelOutput(JSON.stringify({op:'rewrite',reason:'r',steps:p.steps}));assert.equal(parsed.ok,true);
 const normalized=normalizePlan({...p,...parsed.output});assert.equal(normalized.ok,true);assert.deepEqual(normalized.plan.steps[0].completion,p.steps[0].completion);
 assert.match(buildPatchPrompt({plan:normalized.plan}).messages[0].content,/expected/);
 const migrated=patchPlan(plan(write),[{id:'s1',title:'写入与回读',completion:p.steps[0].completion,status:'todo'}],{reason:'split acceptance'});
 assert.deepEqual(migrated.plan.steps[0].completion,p.steps[0].completion);
});
test('generated summaries and other-session receipts cannot satisfy acceptance',()=>{
 events.length=0;execution('write_file',write.args,{ok:true});execution('read_file',read.args,{ok:true,content:'expected'});
 const records=collectRetrievalRecords('other',events);
 assert.notEqual(validateProgress({op:'patch',changes:[{id:'s1',status:'done',evidence:records.map(r=>r.id)}]},plan(),records).output.changes[0].status,'done');
});
