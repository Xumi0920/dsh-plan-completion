import {protocolOutput} from '../support/host-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../index.js';
import {createHostFixture,HOST_KEY,sessionFixture,flushJobs,waitFor,deferred} from '../support/host-fixture.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
const seed=protocolOutput({progress: {version:1,events:[]}, op: 'rewrite',reason:'initial',constraints:['只用隔离副本'],steps:[
 {id:'s1',title:'运行单元测试',status:'todo',completion:{tool:'exec',args:{command:'npm test'}}},
 {id:'s2',title:'整理报告',status:'todo'}, {id:'s3',title:'交付',status:'todo'}],suggestion:'运行单元测试'});
const none={progress: {version:1,events:[]}, op: 'none',reason:'unchanged',suggestion:'等待工具回执'};
function setup(t,responses,config={}){delete globalThis[HOST_KEY];const h=createHostFixture(apply,responses,{observationDebounceMs:100,...config});t.after(()=>{h.dispose();delete globalThis[HOST_KEY]});return h;}
function append(h,s,type,data){const e={type,seq:++s.seq,data};s.events.push(e);h.handlers.get('session/event')(s,e);return e;}
async function boundaryWait(h,n){for(let i=0;i<60;i++){if(h.calls.length>=n){await flushJobs();return;}await new Promise(r=>setTimeout(r,10));}throw Error('boundary did not run');}

test('in-turn probe coalesces bursts, preserves main events, and handles pending then failure with model none',async t=>{
 const h=setup(t,[seed,none,none]);const s=sessionFixture('native-boundary');h.startTurn(s,1);await flushJobs();
 append(h,s,'turn/start',{turn:2});append(h,s,'tool/call',{turn:2,name:'exec',arguments:'{"command":"npm test"}',callId:'c'});
 append(h,s,'step/end',{turn:2,step:1});const original=JSON.stringify(s.events);await boundaryWait(h,2);
 assert.equal(h.calls.length,2);assert.equal(h.state(s.id).plan.steps[0].lifecycle,'awaiting_receipt');assert.equal(JSON.stringify(s.events),original);
 append(h,s,'tool/result',{turn:2,message:{source:{callId:'c'},isError:true,content:[{type:'text',text:'{"exitCode":1}'}]}});
 await boundaryWait(h,3);assert.equal(h.state(s.id).plan.steps[0].status,'blocked');assert.equal(h.state(s.id).stale,false);
 assert.ok(!h.handlers.has('agent/pre-step'),'native context is never intercepted');
});
test('production host accepts matching receipts, retains constraints, and normalizes a single receipt ID',async t=>{
 const s=sessionFixture('matching-receipt');
 const h=setup(t,[seed,()=>{const receipt=collectRetrievalRecords(s.id,s.events).findLast(r=>r.kind==='tool_result');return{progress: {version:1,events:[]}, op: 'patch',reason:'passed',changes:[{id:'s1',status:'done',evidence:receipt.id}],constraints:['只用隔离副本'],suggestion:'整理报告'};}]);
 h.startTurn(s,1);await flushJobs();
 s.events.push({type:'turn/start',seq:11,data:{turn:2}},{type:'tool/call',seq:12,data:{turn:2,callId:'c',name:'exec',arguments:'{"command":"npm test"}'}},{type:'tool/result',seq:13,data:{turn:2,message:{toolCallId:'c',isError:false,content:[{type:'text',text:'{"exitCode":0}'}]}}});
 h.startTurn(s,2);await flushJobs();assert.equal(h.state(s.id).plan.steps[0].status,'done');assert.deepEqual(h.state(s.id).plan.constraints,['只用隔离副本']);
});
test('reset cancels a queued probe and prevents old history from being re-indexed',async t=>{
 const h=setup(t,[seed,none],{enableDebugRoutes:true});const s=sessionFixture('reset-queued');h.startTurn(s,1);await flushJobs();
 append(h,s,'tool/call',{turn:2,name:'exec',arguments:{command:'npm test'},callId:'c'});
 await h.request('/plan-completion/reset',{sessionId:s.id});await new Promise(r=>setTimeout(r,150));assert.equal(h.calls.length,1);assert.equal(h.state(s.id),undefined);
});
test('new progress aborts a stale generation before its debounce deadline',async t=>{
 const pending=deferred();const h=setup(t,[seed,()=>pending.promise,none]);const s=sessionFixture('stale-probe');h.startTurn(s,1);await flushJobs();h.startTurn(s,2);await waitFor(()=>h.calls.length===2);
 append(h,s,'tool/call',{turn:3,name:'exec',arguments:{command:'npm test'},callId:'new'});assert.equal(h.calls[1].signal.aborted,true);pending.resolve(none);await flushJobs();
});
test('repair messages carry native first-class source metadata and preserve the latest user constraint',async t=>{
 const h=setup(t,['not json',seed]);const s=sessionFixture('repair-source');h.startTurn(s,1);await flushJobs();assert.equal(h.calls.length,2);
 const assistant=h.calls[1].messages.find(m=>m.role==='assistant');assert.equal(assistant.source.kind,'model');assert.equal(typeof assistant.id,'string');
 assert.ok(h.calls[1].messages.some(m=>m.role==='user'&&m.content.some(b=>b.text.includes('Continue the next stage'))));
});
test('long native conversation is never truncated or rewritten by helper generation',async t=>{
 const h=setup(t,[seed]);const s=sessionFixture('long-context');const long='原生上下文保留。'.repeat(140000);
 s.events.push({type:'user/message',seq:0,data:{role:'user',content:[{type:'text',text:long}]}});
 h.startTurn(s,1);const original=JSON.stringify(s.events);await flushJobs();assert.equal(JSON.stringify(s.events),original);assert.ok(original.length>1000000);
});

test('host reconciles old composite done on generator failure and recovers after actual readback',async t=>{
 const s=sessionFixture('composite-recovery'),initial=structuredClone(seed);
 initial.steps[0]={acceptance:{scope:'execution',dependsOn:[]},id:'s1',title:'写入并回读校验',status:'todo',completion:{all:[
  {tool:'write_file',args:{path:'fixture.txt'}},{tool:'read_file',args:{path:'fixture.txt'},expect:{field:'content',equals:'expected'}}]}};
 const h=setup(t,[initial,()=>{throw Error('synthetic provider unavailable');},()=>({progress: {version:1,events:[]}, op: 'patch',reason:'verified',changes:[{id:'s1',status:'done',evidence:collectRetrievalRecords(s.id,s.events).filter(r=>r.kind==='tool_result').map(r=>r.id)}],suggestion:'整理报告'})]);
 h.startTurn(s,1);await flushJobs();
 Object.assign(h.state(s.id).plan.steps[0],{status:'done',lifecycle:'verified_receipt',evidence:['stale']});
 s.events.push({seq:11,type:'tool/call',data:{turn:2,callId:'w',name:'write_file',arguments:{path:'fixture.txt'}}},
  {seq:12,type:'tool/result',data:{turn:2,message:{toolCallId:'w',content:[{type:'text',text:'{"ok":true}'}]}}});
 h.startTurn(s,2);await flushJobs();assert.equal(h.state(s.id).plan.steps[0].status,'doing');assert.equal(h.state(s.id).plan.steps[0].lifecycle,'awaiting_receipt');
 s.events.push({seq:21,type:'tool/call',data:{turn:3,callId:'r',name:'read_file',arguments:{path:'fixture.txt'}}},
  {seq:22,type:'tool/result',data:{turn:3,message:{toolCallId:'r',content:[{type:'text',text:'{"ok":true,"content":"expected"}'}]}}});
 h.startTurn(s,3);await flushJobs();assert.equal(h.state(s.id).plan.steps[0].status,'done');assert.equal(h.state(s.id).plan.steps[0].lifecycle,'verified_receipt');
 assert.equal(h.calls.length,3);
});

test('legacy composite completion is invalidated when generation returns none',async t=>{
 const initial=structuredClone(seed);initial.steps[0]={acceptance:{scope:'execution',dependsOn:[]},id:'s1',title:'写入并回读校验',status:'todo',completion:{tool:'write_file',args:{path:'fixture.txt'}}};
 const h=setup(t,[initial,none]),s=sessionFixture('legacy-composite');h.startTurn(s,1);await flushJobs();
 delete h.state(s.id).plan.steps[0].acceptance;
 Object.assign(h.state(s.id).plan.steps[0],{status:'done',lifecycle:'verified_receipt'});
 s.events.push({seq:11,type:'tool/call',data:{turn:2,callId:'w',name:'write_file',arguments:{path:'fixture.txt'}}},
 {seq:12,type:'tool/result',data:{turn:2,message:{toolCallId:'w',content:[{type:'text',text:'{"ok":true}'}]}}});
 h.startTurn(s,2);await flushJobs();assert.equal(h.state(s.id).plan.steps[0].status,'doing');assert.equal(h.state(s.id).plan.steps[0].lifecycle,'acceptance_missing');
});
