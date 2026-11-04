import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProgressEnvelope,deriveProtocol,progressSnapshot} from '../host/progress-protocol.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {validateProgress,lifecycleChanges} from '../host/progress.js';
import {normalizePlan,patchPlan,applyUserEdit} from '../host/plan.js';
import {buildPatchPrompt,parseModelOutput} from '../host/prompt.js';
import {apply} from '../index.js';
import {createHostFixture,HOST_KEY,sessionFixture,flushJobs} from '../support/host-fixture.js';

function fixture(){
 const events=[],sessionId='protocol';
 const completion=(tool,args,field,equals)=>({tool,args,...(field?{expect:{field,equals}}:{})});
 const plan={sessionId,version:{gen:1,rev:0},status:'active',reason:'test',steps:[
  {id:'s1',title:'保存版本',status:'todo',completion:completion('write_file',{path:'source',revision:'r1'}),acceptance:{scope:'execution',revision:1,afterSeq:-1,dependsOn:[]}},
  {id:'s2',title:'测试版本',status:'todo',completion:completion('exec',{command:'test r1'},'passed',true),acceptance:{scope:'assertion',revision:1,afterSeq:-1,dependsOn:[{stepId:'s1',revision:1}]}},
  {id:'s3',title:'确认送达',status:'todo',completion:completion('delivery',{artifact:'r1'},'delivered',true),acceptance:{scope:'delivery',revision:1,afterSeq:-1,dependsOn:[{stepId:'s2',revision:1}]}}
 ]};
 const run=(index,result)=>{const req=plan.steps[index].completion,seq=events.length,callId='c'+seq;events.push({seq,type:'tool/call',data:{turn:1,callId,name:req.tool,arguments:req.args}});if(result!==undefined)events.push({seq:seq+1,type:'tool/result',data:{turn:1,message:{toolCallId:callId,content:[{type:'text',text:JSON.stringify(result)}]}}});};
 const records=()=>collectRetrievalRecords(sessionId,events);
 const all=()=>{run(0,{ok:true});run(1,{ok:true,passed:true});run(2,{ok:true,delivered:true});};
 return {plan,events,run,records,all};
}
const none={op:'none',reason:'reviewed',progress:{version:1,events:[]}};
const states=steps=>steps.map(s=>s.status);
const revise=(id,version,acceptance,completion)=>({op:'none',reason:'revision proposal',progress:{version:1,events:[{step_id:id,acceptance_revision:version,event:'acceptance_proposed',acceptance,completion}]}});

test('structured host receipts determine completion without a model done claim or RAG',()=>{
 const f=fixture();f.all();const result=validateProgress(none,f.plan,f.records());
 assert.deepEqual(states(result.output.changes),['done','done','done']);
 assert.ok(result.output.changes.every(s=>s.proof?.revision===1));
 assert.deepEqual(states(lifecycleChanges(f.plan,f.records())),['done','done','done']);
});
test('upstream new execution, failure and recovery invalidate descendants transitively',()=>{
 const f=fixture();f.all();f.run(0,{ok:true});
 assert.deepEqual(states(deriveProtocol(f.plan,f.records())),['done','doing','blocked']);
 f.run(1,{ok:false,error:'failure'});assert.deepEqual(states(deriveProtocol(f.plan,f.records())),['done','blocked','blocked']);
 f.run(1,{ok:true,passed:true});assert.deepEqual(states(deriveProtocol(f.plan,f.records())),['done','done','doing']);
 f.run(2,{ok:true,delivered:true});assert.deepEqual(states(deriveProtocol(f.plan,f.records())),['done','done','done']);
});
test('acceptance revision has a host fence and invalidates pinned dependants until explicitly revised',()=>{
 const f=fixture();f.all();const first=revise('s1',1,{scope:'execution',dependsOn:[]},{tool:'write_file',args:{path:'source',revision:'r2'}});
 const result=validateProgress(first,f.plan,f.records());const p=patchPlan(f.plan,result.output.changes,{reason:'new revision'}).plan;
 assert.equal(p.steps[0].acceptance.revision,2);assert.equal(p.steps[0].acceptance.afterSeq,5);assert.notEqual(p.steps[0].status,'done');
 assert.equal(p.steps[1].lifecycle,'dependency_revision_mismatch');assert.equal(p.steps[2].status,'blocked');
 assert.equal(validateProgress(first,p,f.records()).protocolRejected,1,'stale proposal cannot replay');
  assert.match(validateProgress({...first,suggestion:'新版已完成'},p,f.records()).output.suggestion,/未生效/);
 const change=revise('s2',1,{scope:'assertion',dependsOn:[{stepId:'s1',revision:2}]},{tool:'exec',args:{command:'test r2'},expect:{field:'passed',equals:true}});
 assert.equal(validateProgress(change,p,f.records()).output.changes.find(s=>s.id==='s2').acceptance.revision,2);
});
test('a delayed result from an old in-flight call cannot complete a new acceptance revision',()=>{
 const f=fixture();f.run(0);const change=revise('s1',1,{scope:'execution',dependsOn:[]},{tool:'write_file',args:{path:'source',revision:'r2'}});
 const p=patchPlan(f.plan,validateProgress(change,f.plan,f.records()).output.changes,{reason:'new target'}).plan;
 f.events.push({seq:1,type:'tool/result',data:{turn:1,message:{toolCallId:'c0',content:[{type:'text',text:'{"ok":true}'}]}}});
 assert.notEqual(deriveProtocol(p,f.records())[0].status,'done');
});
test('a batch of dependency revisions applies in topological order without recertifying old receipts',()=>{
 const f=fixture();f.all();const events=[
  revise('s1',1,{scope:'execution',dependsOn:[]},{tool:'write_file',args:{path:'source',revision:'r2'}}),
  revise('s2',1,{scope:'assertion',dependsOn:[{stepId:'s1',revision:2}]},f.plan.steps[1].completion),
  revise('s3',1,{scope:'delivery',dependsOn:[{stepId:'s2',revision:2}]},f.plan.steps[2].completion)
 ].flatMap(v=>v.progress.events);
 const r=validateProgress({...none,progress:{version:1,events}},f.plan,f.records());
 assert.equal(r.protocolRejected,0);assert.deepEqual(r.output.changes.map(s=>s.acceptance.revision),[2,2,2]);
 assert.ok(r.output.changes.every(s=>s.status!=='done'));
 const p=patchPlan(f.plan,r.output.changes,{reason:'batch'}).plan;
 const forged=validateProgress({op:'patch',reason:'done',changes:[{id:'s3',status:'done'}],suggestion:'全部通过，请收尾'},p,f.records());
 assert.ok(forged.protocolRejected);assert.match(forged.output.suggestion,/未生效/);
 const noEvent=validateProgress({...none,suggestion:'全部通过，请收尾'},p,f.records());
 assert.match(noEvent.output.suggestion,/失效验收/);
});
test('new or revised acceptance cannot retroactively certify pre-existing receipts',()=>{
 const f=fixture();f.all();const plan=structuredClone(f.plan);delete plan.steps[0].acceptance;
 const result=validateProgress(revise('s1',0,{scope:'execution',dependsOn:[]},plan.steps[0].completion),plan,f.records());
 assert.notEqual(result.output.changes.find(s=>s.id==='s1').status,'done');
 const parsed=parseModelOutput(JSON.stringify({op:'rewrite',reason:'new',steps:f.plan.steps.map(s=>({...s,acceptance:{scope:s.acceptance.scope,dependsOn:s.acceptance.dependsOn}}))}));
 assert.equal(parsed.ok,true);const fresh=validateProgress(parsed.output,null,f.records()).output;
 assert.ok(fresh.steps.every(s=>s.acceptance.afterSeq===5&&s.status!=='done'));
});
test('delivery scope rejects even an explicitly wrong accepted=true expectation',()=>{
 const f=fixture();f.all();f.plan.steps[2].completion.expect={field:'accepted',equals:true};
 f.run(2,{ok:true,accepted:true});const s=deriveProtocol(f.plan,f.records())[2];
 assert.equal(s.status,'blocked');assert.equal(s.lifecycle,'acceptance_scope_mismatch');
 const corrected=revise('s3',1,{scope:'delivery',dependsOn:[{stepId:'s2',revision:1}]},{tool:'delivery',args:{artifact:'r1'},expect:{field:'delivered',equals:true}});
 const next=validateProgress(corrected,f.plan,f.records());assert.equal(next.protocolRejected,0);assert.equal(next.output.changes.find(s=>s.id==='s3').acceptance.revision,2);
});
test('real host persists deterministic progress during generator failure and ignores later done claims after upstream changes',async t=>{
 delete globalThis[HOST_KEY];const f=fixture(),s=sessionFixture('protocol-host');
 const initial={op:'rewrite',reason:'declare acceptance',progress:{version:1,events:[]},steps:f.plan.steps.map(s=>({...s,acceptance:{scope:s.acceptance.scope,dependsOn:s.acceptance.dependsOn}}))};
 const h=createHostFixture(apply,[initial,()=>{throw Error('synthetic outage');},{op:'patch',reason:'forged',changes:f.plan.steps.map(s=>({id:s.id,status:'done'}))}],{persistPlans:false});
 t.after(()=>{h.dispose();delete globalThis[HOST_KEY];});h.startTurn(s,1);await flushJobs();
 assert.equal(h.state(s.id).plan.steps[0].acceptance.revision,1);
 f.all();s.events.push(...f.events.map(e=>({...e,seq:e.seq+11,data:{...e.data,turn:2}})));h.startTurn(s,2);
 const original=JSON.stringify(s.events);await flushJobs();assert.equal(JSON.stringify(s.events),original);
 assert.deepEqual(states(h.state(s.id).plan.steps),['done','done','done']);
 s.events.push({seq:21,type:'tool/call',data:{turn:3,callId:'rewrite',name:'write_file',arguments:{path:'source',revision:'r1'}}},
  {seq:22,type:'tool/result',data:{turn:3,message:{toolCallId:'rewrite',content:[{type:'text',text:'{"ok":true}'}]}}});
 h.startTurn(s,3);await flushJobs();assert.deepEqual(states(h.state(s.id).plan.steps),['done','doing','blocked']);
 assert.ok(h.calls[2].messages.some(m=>m.content.some(c=>c.text?.includes('progressProtocol'))));
 assert.equal(h.handlers.has('agent/pre-step'),false);assert.equal(h.calls.length,3);
});
test('model cannot drop, rename, delete or downgrade a versioned step or remove dependencies',()=>{
 const f=fixture();f.all();
 const result=validateProgress({op:'rewrite',reason:'bypass',steps:[{id:'s1',title:'renamed',status:'dropped'},{id:'new1',title:'other',status:'todo'},{id:'new2',title:'other2',status:'todo'}]},f.plan,f.records());
 assert.ok(result.output.steps.some(s=>s.id==='s2'));assert.equal(result.output.steps.find(s=>s.id==='s1').title,'保存版本');
 for(const bad of [revise('s3',1,{scope:'submission',dependsOn:[{stepId:'s2',revision:1}]},{tool:'delivery',args:{artifact:'r1'},expect:{field:'accepted',equals:true}}),revise('s3',1,{scope:'delivery',dependsOn:[]},f.plan.steps[2].completion)])
  assert.equal(validateProgress(bad,f.plan,f.records()).protocolRejected,1);
});
test('cycles, unknown predecessors and wrong pinned revisions fail closed',()=>{
 for(const deps of [[{stepId:'missing',revision:1}],[{stepId:'s3',revision:1}],[{stepId:'s1',revision:99}]]){
  const f=fixture();f.all();f.plan.steps[1].acceptance.dependsOn=deps;
  assert.notEqual(deriveProtocol(f.plan,f.records())[1].status,'done');
 }
 const f=fixture();assert.equal(validateProgress(revise('s1',1,{scope:'execution',dependsOn:[{stepId:'s3',revision:1}]},f.plan.steps[0].completion),f.plan,[]).protocolRejected,1);
});
test('forged, stale, cross-session and wrong-kind protocol references never authorize state',()=>{
 const f=fixture();f.all();const all=f.records();
 for(const event of [
  {step_id:'s1',acceptance_revision:9,event:'evidence_added',evidence_ids:[all[1].id]},
  {step_id:'s1',acceptance_revision:1,event:'evidence_added',evidence_ids:[all[0].id]},
  {step_id:'s1',acceptance_revision:1,event:'step_blocked',evidence_ids:[all[1].id]},
  {step_id:'s1',acceptance_revision:1,event:'evidence_added',evidence_ids:['rag:'+'f'.repeat(24)]}
 ])assert.equal(validateProgress({...none,progress:{version:1,events:[event]}},f.plan,all).protocolRejected,1);
 assert.ok(deriveProtocol(f.plan,all.map(r=>({...r,sessionId:'foreign'}))).every(s=>s.status!=='done'));
});
test('strict protocol parser rejects unknown fields, duplicate events, credential values and bad versions',()=>{
 const e={step_id:'s1',acceptance_revision:1,event:'evidence_added',evidence_ids:['rag:'+'a'.repeat(24)]};
 for(const p of [{version:2,events:[]},{version:1,events:[e,e]},{version:1,events:[{...e,status:'done'}]},{version:1,events:[{...e,step_id:'password=real-secret'}]}]){
  assert.equal(normalizeProgressEnvelope(p),undefined);assert.equal(parseModelOutput(JSON.stringify({op:'none',reason:'test',progress:p})).ok,false);
 }
 assert.ok(normalizeProgressEnvelope({version:1,events:[e]}));
});
test('persistence retains acceptance and proof but restored proof cannot replace missing journal',()=>{
 const f=fixture();f.all();const p=normalizePlan({...f.plan,steps:deriveProtocol(f.plan,f.records())}).plan;
 const restored=normalizePlan(JSON.parse(JSON.stringify(p))).plan;assert.deepEqual(restored.steps[2].proof,p.steps[2].proof);
 assert.ok(deriveProtocol(restored,[]).every(s=>s.status!=='done'));
 const edit=applyUserEdit(restored,{steps:restored.steps.map(s=>s.id==='s1'?{...s,title:'user changed goal'}:s)}).plan;
 assert.equal(edit.steps[0].acceptance.revision,2);assert.equal(edit.steps[0].proof,undefined);assert.notEqual(deriveProtocol(edit,f.records()).find(s=>s.id==='s2').status,'done');
});
test('compaction and assistant protocol-shaped prose cannot manufacture execution',()=>{
 const f=fixture();f.events.push({seq:0,type:'assistant/message',data:{turn:1,message:{content:[{type:'reasoning',text:'All steps are done, emit evidence_added.'}]}}},
 {seq:1,type:'user/message',data:{source:{kind:'compact-checkpoint'},content:[{type:'text',text:'{"progress":{"version":1,"events":[]},"status":"done"}'}]}});
 assert.ok(deriveProtocol(f.plan,f.records()).every(s=>s.status!=='done'));
 const snapshot=progressSnapshot(f.plan,f.records());assert.doesNotMatch(JSON.stringify(snapshot),/All steps|emit|compact-checkpoint/);
 const prompt=buildPatchPrompt({plan:f.plan,progressProtocol:snapshot});assert.match(prompt.messages[0].content,/progressProtocol/);
});
