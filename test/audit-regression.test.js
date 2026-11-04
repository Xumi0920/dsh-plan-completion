import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../index.js';
import {createFileStore} from '../host/store.js';
import {normalizePlan} from '../host/plan.js';
import {deriveProtocol} from '../host/progress-protocol.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {parseModelOutput} from '../host/prompt.js';
import {createHostFixture, sessionFixture, flushJobs, waitFor, deferred, initialOutput} from '../support/host-fixture.js';

function host(t, responses=[], config={}) {
  const h=createHostFixture(apply,responses,config);t.after(()=>h.dispose());return h;
}
async function saved(t) {
  const dir=await mkdtemp(join(tmpdir(),'dpc-audit-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const plan={sessionId:'restore',version:{gen:1,rev:0},status:'active',reason:'Synthetic saved plan',steps:[0,1,2].map(i=>({
    id:'s'+(i+1),title:'Check '+i,status:'todo',completion:{tool:'exec',args:{command:'check-'+i},expect:{field:'passed',equals:true}},
    acceptance:{scope:'assertion',revision:1,afterSeq:-1,dependsOn:i?[{stepId:'s'+i,revision:1}]:[]},
  }))};
  const events=[];
  function run(i,passed) {const id='c'+events.length;events.push(
    {seq:events.length,type:'tool/call',data:{turn:1,callId:id,name:'exec',arguments:{command:'check-'+i}}},
    {seq:events.length+1,type:'tool/result',data:{turn:1,message:{toolCallId:id,content:[{type:'text',text:JSON.stringify({ok:passed,passed})}]}}},
  );}
  for(let i=0;i<3;i++)run(i,true);
  const checked=normalizePlan({...plan,steps:deriveProtocol(plan,collectRetrievalRecords(plan.sessionId,events))});
  assert.equal(checked.ok,true,JSON.stringify(checked));const normalized=checked.plan;
  assert.equal(await createFileStore(dir).put(normalized),true);
  return {dir,plan:normalized,events,run};
}
function persistence(h,events,unknown=false) {
  let reads=0;
  h.services.sessionPersistence={async stat(){return unknown?{}:{eventCount:events.length}},async open(){return {
    async read(offset,limit){reads++;return {events:events.slice(offset,offset+limit)}},async close(){},
  }}};
  return ()=>reads;
}

for(const failure of ['throws','missing','incomplete']) test('fixed model fails closed: '+failure,async t=>{
  const h=host(t,[],{modelPolicy:'fixed',fixedProvider:'local-only',fixedModel:failure==='incomplete'?'':'q8'});
  h.services.agentDefaultModel.currentSelection=()=>({provider:'cloud-other',model:'remote'});
  h.services.llm.resolveModelInfo=async()=>{if(failure==='throws')throw Error('unavailable');return null};
  const s=sessionFixture('fixed');h.startTurn(s,1);await flushJobs();
  assert.equal(h.calls.length,0);
  assert.match(h.state(s.id).suggestion.text,/固定模型不可用/);
  const verify=await h.request('/plan-completion/verify',{sessionId:s.id});
  assert.equal(verify.body.error,'no-model-route');assert.equal(h.calls.length,0);
});

test('policy change cancels pending generation and verification, ignoring late output',async t=>{
  const generation=deferred(),verification=deferred();
  const h=host(t,[initialOutput(),()=>generation.promise,()=>verification.promise]);const s=sessionFixture('policy-change');
  h.startTurn(s,1);await flushJobs();h.startTurn(s,2);await waitFor(()=>h.calls.length===2);
  const request=h.request('/plan-completion/verify',{sessionId:s.id});await waitFor(()=>h.calls.length===3);
  await h.request('/plan-completion/settings',{modelPolicy:'fixed',fixedProvider:'local',fixedModel:'chosen'});
  assert.equal(h.calls[1].signal.aborted,true);assert.equal(h.calls[2].signal.aborted,true);
  const before=structuredClone(h.state(s.id));generation.resolve(initialOutput());
  verification.resolve({assessment:'late',mismatches:[],suggestion:'late'});
  assert.equal((await request).body.error,'request-cancelled');await flushJobs();assert.deepEqual(h.state(s.id),before);
});

test('restored completion is reconciled against a newer upstream failure, including warm',async t=>{
  const f=await saved(t);f.run(0,false);
  const h=host(t,[],{storageDir:f.dir,modelCalls:false,warmBackfill:false});const reads=persistence(h,f.events);
  const view=(await h.request('/plan-completion/state?sessionId=restore')).body;
  assert.deepEqual(view.steps.map(s=>s.status),['blocked','blocked','blocked']);assert.equal(view.stale,false);assert.ok(reads()>0);
  const warm=(await h.request('/plan-completion/warm',{sessionId:'restore'})).body;
  assert.equal(warm.revalidated,true);assert.equal(h.calls.length,0);
});

test('unavailable journal hides saved done and recovers when persistence comes back',async t=>{
  const f=await saved(t);const h=host(t,[],{storageDir:f.dir,modelCalls:false});
  const old=(await h.request('/plan-completion/state?sessionId=restore')).body;
  assert.equal(old.stale,true);assert.equal(old.freshness,'journal-unavailable');assert.ok(old.steps.every(s=>s.status!=='done'&&!s.proof));
  persistence(h,f.events);
  const current=(await h.request('/plan-completion/state?sessionId=restore')).body;
  assert.equal(current.stale,false);assert.ok(current.steps.every(s=>s.status==='done'&&s.proof));
});

test('unknown journal length pages past the first 400 events to find newer failure',async t=>{
  const f=await saved(t);
  while(f.events.length<450)f.events.push({seq:f.events.length,type:'assistant/message',data:{message:{content:'synthetic filler'}}});
  f.run(0,false);const h=host(t,[],{storageDir:f.dir,modelCalls:false});const reads=persistence(h,f.events,true);
  const view=(await h.request('/plan-completion/state?sessionId=restore')).body;
  assert.ok(reads()>=2);assert.deepEqual(view.steps.map(s=>s.status),['blocked','blocked','blocked']);
});

test('restored pinned dependency versions are checked instead of trusting saved proof',async t=>{
  const f=await saved(t);f.plan.steps[0].acceptance.revision=2;await createFileStore(f.dir).put(f.plan);
  const h=host(t,[],{storageDir:f.dir,modelCalls:false});persistence(h,f.events);
  const view=(await h.request('/plan-completion/state?sessionId=restore')).body;
  assert.equal(view.steps[1].status,'blocked');assert.equal(view.steps[1].lifecycle,'dependency_revision_mismatch');
});

test('legacy settings and plan data migrate in place without treating old done as verified',async t=>{
  const f=await saved(t);for(const step of f.plan.steps)delete step.acceptance;
  await createFileStore(f.dir).put(f.plan);
  await writeFile(join(f.dir,'settings.json'),JSON.stringify({modelPolicy:'fixed',fixedProvider:'old-local',fixedModel:'old-model',modelCalls:false}));
  const h=host(t,[],{storageDir:f.dir,modelPolicy:'default',fixedProvider:'other'});persistence(h,f.events);
  const config=(await h.request('/plan-completion/settings')).body.settings;
  assert.equal(config.fixedProvider,'old-local');assert.equal(config.fixedModel,'old-model');assert.equal(config.modelCalls,false);
  const view=(await h.request('/plan-completion/state?sessionId=restore')).body;
  assert.ok(view.steps.every(s=>s.acceptance.revision===1&&s.lifecycle==='awaiting_manual_acceptance'&&s.status==='todo'));
});

for(const field of ['progress','acceptance']) test('new output missing '+field+' is rejected and never silently treated as legacy',async t=>{
  const malformed=initialOutput();if(field==='progress')delete malformed.progress;else delete malformed.steps[1].acceptance;
  assert.equal(parseModelOutput(JSON.stringify(malformed),{requireProtocol:true}).ok,false);
  const h=host(t,[malformed,malformed]);const s=sessionFixture('missing-'+field);h.startTurn(s,1);await flushJobs();
  assert.equal(h.calls.length,2);assert.equal(h.state(s.id).plan.version.gen,0);
  assert.ok(h.state(s.id).plan.steps.every(s=>s.status==='todo'&&s.acceptance.scope==='manual'));
  assert.match(h.state(s.id).suggestion.text,/格式未通过/);
});

test('empty proof representations do not keep incrementing unchanged manual plans',async t=>{
  const h=host(t,[initialOutput(),{op:'none',reason:'unchanged',progress:{version:1,events:[]}}]);const s=sessionFixture('stable-version');
  h.startTurn(s,1);await flushJobs();const v=h.state(s.id).plan.version;
  for(let i=0;i<3;i++)await h.core.reconcileSession(s.id,s.events);
  h.startTurn(s,2);await flushJobs();assert.deepEqual(h.state(s.id).plan.version,v);
});
