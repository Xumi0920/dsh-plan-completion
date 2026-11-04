import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../index.js';
import {attach as observer} from '../host/observer.js';
import {attach as generator} from '../host/generator.js';
import {attach as retrieval} from '../host/retrieval.js';
import {attach as api} from '../host/api.js';
import {createHostFixture, initialOutput, sessionFixture, flushJobs, waitFor, deferred} from '../support/host-fixture.js';

function mount(h,attach) {
  const cleanups=[];
  const ctx={get:h.ctx.get,effect(fn){const cleanup=fn();if(typeof cleanup==='function')cleanups.push(cleanup)},
    on(name,fn){h.handlers.set(name,fn);cleanups.push(()=>{if(h.handlers.get(name)===fn)h.handlers.delete(name)})},
    inject(_deps,fn){return fn({...h.services,get:h.ctx.get,effect:ctx.effect})},
  };
  attach(ctx,h.core);
  return ()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup()};
}
function setup(t,responses=[]) {
  const h=createHostFixture(apply,responses,{components:'managed',persistPlans:false,observationDebounceMs:100});
  const components={};
  for(const [name,fn] of Object.entries({api,observer,retrieval,generator}))components[name]=mount(h,fn);
  t.after(()=>{Object.values(components).forEach(stop=>stop());h.dispose()});return {h,components};
}
function seed(h,id) {
  const plan={sessionId:id,version:{gen:1,rev:0},reason:'fixture',status:'active',steps:[0,1,2].map(i=>({id:'s'+(i+1),title:'Check '+i,status:'todo',completion:{tool:'exec',args:{command:'check-'+i}},acceptance:{scope:'execution',revision:1,afterSeq:-1,dependsOn:i?[{stepId:'s'+i,revision:1}]:[]}}))};
  h.core.store.put(plan);h.core.states.set(id,{plan,stale:false});return plan;
}
function receipt(h,s,i,ok) {
  const call={type:'tool/call',seq:++s.seq,data:{turn:1,callId:'c'+s.seq,name:'exec',arguments:{command:'check-'+i}}};s.events.push(call);h.handlers.get('session/event')?.(s,call);
  const end={type:'tool/result',seq:++s.seq,data:{turn:1,message:{toolCallId:call.data.callId,content:[{type:'text',text:JSON.stringify({ok})}]}}};s.events.push(end);h.handlers.get('session/event')?.(s,end);
}

test('managed root does not auto-start duplicate component handlers',t=>{
  const h=createHostFixture(apply,[],{components:'managed'});t.after(()=>h.dispose());
  assert.equal(h.routes.size,0);assert.equal(h.handlers.size,0);
  const stop=mount(h,api);t.after(stop);const count=h.routes.size;
  const duplicate=mount(h,api);duplicate();assert.equal(h.routes.size,count);assert.equal(h.core.components.api,true);
});

test('legacy profile config without the managed marker honors explicitly disabled rows',t=>{
  const h=createHostFixture((ctx,config)=>{
    const get=ctx.get;
    ctx.get=name=>name==='loader'?{entries:()=>[{options:{id:'plan-completion-observer',name:'dsh-plan-completion/observer',disabled:true}}]}:get(name);
    return apply(ctx,config);
  },[],{modelCalls:false});t.after(()=>h.dispose());
  assert.equal(h.handlers.size,0);assert.equal(h.routes.size,0);
  assert.equal(h.core.components.observer,false);assert.equal(h.core.components.generator,false);
});

test('observer reconciles completion and dependent failure with generator and RAG disabled',async t=>{
  const {h,components}=setup(t);components.generator();components.retrieval();
  const s=sessionFixture('components-state');seed(h,s.id);
  for(let i=0;i<3;i++){receipt(h,s,i,true);await flushJobs()}
  assert.deepEqual(h.state(s.id).plan.steps.map(s=>s.status),['done','done','done']);
  receipt(h,s,0,false);await flushJobs();
  assert.deepEqual(h.state(s.id).plan.steps.map(s=>s.status),['blocked','blocked','blocked']);
  assert.equal(h.calls.length,0);assert.equal(h.core.publicView(s.id).stale,false);
});

test('generator disable aborts pending work and reload cannot accept its late proposal',async t=>{
  const pending=deferred();const {h,components}=setup(t,[()=>pending.promise,initialOutput()]);const s=sessionFixture('generator-reload');
  h.startTurn(s,1);await waitFor(()=>h.calls.length===1);components.generator();assert.equal(h.calls[0].signal.aborted,true);
  components.generator=mount(h,generator);h.startTurn(s,2);await flushJobs();const current=structuredClone(h.state(s.id));
  pending.resolve(initialOutput());await flushJobs();assert.deepEqual(h.state(s.id),current);assert.equal(h.core.components.generator,true);
});

test('API disable removes routes and re-enable has one live route per endpoint',async t=>{
  const {h,components}=setup(t);const count=h.routes.size;
  components.api();assert.equal(h.routes.size,0);assert.equal(h.core.components.observer,true);
  components.api=mount(h,api);assert.equal(h.routes.size,count);
  h.services.connection.requestRejection=()=>403;
  assert.equal((await h.request('/plan-completion/state?sessionId=none')).status,403);
});

test('observer disable masks cached completion until a new journal check',async t=>{
  const {h,components}=setup(t);components.generator();const s=sessionFixture('observer-reload');seed(h,s.id);
  for(let i=0;i<3;i++){receipt(h,s,i,true);await flushJobs()}
  assert.ok(h.core.publicView(s.id).steps.every(s=>s.status==='done'));
  components.observer();const off=h.core.publicView(s.id);assert.equal(off.freshness,'observer-disabled');assert.equal(off.stale,true);assert.ok(off.steps.every(s=>s.status!=='done'));
  receipt(h,s,0,false);
  components.observer=mount(h,observer);
  await flushJobs();
  assert.deepEqual(h.core.publicView(s.id).steps.map(s=>s.status),['blocked','blocked','blocked']);
});

test('retrieval disable clears views and re-enable retains authoritative plan state',async t=>{
  const {h,components}=setup(t);const s=sessionFixture('retrieval-reload');seed(h,s.id);const plan=structuredClone(h.state(s.id).plan);
  h.core.ragViews.set(s.id,{mode:'vector'});components.retrieval();
  assert.equal(h.core.publicView(s.id).retrieval.mode,'disabled');assert.deepEqual(h.state(s.id).plan,plan);
  components.retrieval=mount(h,retrieval);assert.deepEqual(h.state(s.id).plan,plan);
});
