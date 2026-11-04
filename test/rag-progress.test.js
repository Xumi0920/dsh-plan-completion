import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRetrievalRecords, redactData, redactSecrets } from '../host/rag-evidence.js';
import { validateProgress, lifecycleChanges } from '../host/progress.js';
import { createRag, localEmbeddingURL, createEmbeddingClient } from '../host/rag.js';
import { normalizePlan, patchPlan } from '../host/plan.js';
import { parseModelOutput, buildPatchPrompt } from '../host/prompt.js';
import http from 'node:http';

const plan={sessionId:'a',reason:'test', steps:[{id:'s1',title:'运行单元测试',status:'todo',completion:{tool:'exec',args:{command:'npm test'}}},{id:'s2',title:'复核',status:'todo'},{id:'s3',title:'交付',status:'todo'}]};
const event=(type,seq,data)=>({type,seq,data});
const call=(seq=1,args={command:'npm test'},turn=1)=>event('tool/call',seq,{turn,callId:'c'+seq,name:'exec',arguments:args});
const result=(seq=2,callId='c1',text='{"exitCode":0}',turn=1)=>event('tool/result',seq,{turn,message:{role:'tool',toolCallId:callId,content:[{type:'text',text}]}});
const rows=events=>collectRetrievalRecords('a',events);
const proposed=records=>({op:'patch',changes:[{id:'s1',status:'done',evidence:records.filter(r=>r.kind==='tool_result').map(r=>r.id)}]});
const status=(records,base=plan)=>validateProgress(proposed(records),base,records).output.changes[0];

test('completion requires an established matching target and actual successful receipt',()=>{
 const r=rows([call(),result()]);assert.equal(status(r).status,'done');assert.equal(status(r).lifecycle,'verified_receipt');
 assert.equal(status(rows([call(1,{command:'echo unrelated'}),result()])).status,'todo');
 const p=structuredClone(plan);delete p.steps[0].completion;const o=proposed(r);o.changes[0].completion=plan.steps[0].completion;
 assert.equal(validateProgress(o,p,r).output.changes[0].status,'todo');
});
test('English thought and Chinese assistant claims cannot certify completion or forge receipts',()=>{
 const r=rows([event('assistant/message',1,{turn:1,message:{content:[{type:'reasoning',text:'I will run npm test, then mark it done.'},{type:'text',text:'测试已完成，全部通过。'}]}})]);
 assert.deepEqual(r.map(r=>r.kind),['assistant_claim','reasoning_intent']);assert.equal(status(r).status,'todo');
 const intent={op:'patch',changes:[{id:'s1',status:'doing'}]};assert.equal(validateProgress(intent,plan,r).output.changes[0].status,'todo');
});
test('latest pending, failed, interrupted and unknown calls override stale success',()=>{
 const success=[call(),result()];
 assert.equal(status(rows([...success,call(3)])).lifecycle,'awaiting_receipt');
 assert.equal(status(rows([...success,call(3),result(4,'c3','{"exitCode":1}')])).status,'blocked');
 assert.equal(status(rows([call(),result(2,'c1','Process running with session ID 7')])).lifecycle,'outcome_unverified');
 assert.equal(status(rows([call(),result(),event('turn/end',3,{turn:1,reason:{kind:'interrupted'}})])).status,'blocked');
 assert.equal(status(rows([call(),result(2,'c1','Looks fine')])).status,'doing');
});
test('unmatched, duplicate, cross-turn and cross-session receipts are ineligible',()=>{
 for(const events of [[result()],[call(),result(2,'c1','{"exitCode":0}',2)],[call(),{...call(),seq:2},result(3)]]) assert.notEqual(status(rows(events)).status,'done');
 assert.notEqual(status(collectRetrievalRecords('b',[call(),result()])).status,'done');
});
test('title changes invalidate old done, manual user status remains authoritative',()=>{
 const r=rows([call(),result()]);const p=structuredClone(plan);Object.assign(p.steps[0],{status:'done',lifecycle:'verified_receipt'});
 const o=proposed(r);o.changes[0].title='部署到生产';assert.equal(validateProgress(o,p,r).output.changes[0].status,'todo');
 p.steps[0].source='user';assert.equal(validateProgress({op:'patch',changes:[{id:'s1',status:'todo'}]},p,r).output.changes[0].status,'done');
});
test('lifecycle reconciliation runs independently of model decisions',()=>{
 const r=rows([call()]);const changes=lifecycleChanges(plan,r);assert.equal(changes[0].status,'doing');
 const changed=patchPlan(plan,changes,{reason:'receipt'});assert.equal(changed.ok,true);assert.equal(changed.plan.steps[0].completion.args.command,'npm test');
});
test('blocked state, target and constraints survive parse, persistence normalization and prompt',()=>{
 const raw={op:'rewrite',reason:'r',steps:plan.steps,constraints:['保留原生长上下文','不修改生产配置']};raw.steps[0].status='blocked';
 const parsed=parseModelOutput(JSON.stringify(raw));assert.equal(parsed.ok,true);
 const norm=normalizePlan({...plan,...parsed.output});assert.equal(norm.ok,true);assert.equal(norm.plan.steps[0].completion.tool,'exec');
 const prompt=buildPatchPrompt({plan:norm.plan,retrieval:{mode:'hybrid',records:[{kind:'reasoning_intent',text:'I will test'}]}});
 assert.match(prompt.system,/不是完成证据/);assert.match(prompt.messages[0].content,/reasoning_intent/);assert.match(prompt.messages[0].content,/保留原生长上下文/);
});
test('credential minimization keeps structured payload valid',()=>{
 const clean=redactData({password:'private',text:'Authorization: Bearer secret-token-12345',nested:{api_key:'secret'},url:'https://u:p@example.com/?token=abc'});
 assert.equal(clean.password,'[REDACTED]');assert.equal(clean.nested.api_key,'[REDACTED]');assert.doesNotMatch(JSON.stringify(clean),/private|secret-token|u:p|token=abc/);
 assert.doesNotMatch(redactSecrets('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'),/\nsecret/);
});

test('dry-run and explicitly unexecuted results cannot become completion receipts',()=>{
 for(const text of ['{"ok":true,"dryRun":true}','{"ok":true,"executed":false}','{"ok":true,"simulated":true}'])assert.equal(status(rows([call(),result(2,'c1',text)])).status,'doing');
});
test('cross-language semantic matches survive many weak same-language lexical hits',async()=>{
 const vector=score=>Float32Array.from([score,Math.sqrt(1-score*score)]);
 const client={async embed(texts){return texts.map(t=>t.startsWith('Instruct:')?vector(1):t.startsWith('I intend')?vector(.9):vector(.3));},close(){}};
 const rag=createRag({enabled:true,topK:5},{client});
 try{
  const events=Array.from({length:60},(_,i)=>event('user/message',i,{content:'普通模块记录，界面菜单颜色与间距 '+i}));
  events.push(event('assistant/message',60,{message:{content:[{type:'reasoning',text:'I intend to validate cache invalidation with unit tests.'}]}}));
  rag.sync('a',events);await rag.idle();const got=await rag.retrieve('a','缓存模块准备如何验证，请找英文思考意图');
  assert.equal(got.mode,'hybrid');assert.equal(got.records[0].kind,'reasoning_intent');assert.equal(got.records[0].completionEligible,false);
 }finally{rag.close();}
});
test('embedding endpoints only admit literal loopback without credentials or alternate paths',()=>{
 for(const u of ['https://remote.test/v1/embeddings','http://localhost/v1/embeddings','http://127.0.0.1@remote.test/v1/embeddings','http://127.0.0.1/v1/embeddings?token=secret','http://127.0.0.1/other']) assert.throws(()=>localEmbeddingURL(u));
 assert.equal(localEmbeddingURL('http://127.0.0.1:11434/v1/embeddings').port,'11434');
});
test('RAG retains older relevant records, isolates sessions, clears on forget and falls back offline',async()=>{
 const seen=[];const client={async embed(texts){seen.push(...texts);throw Error('offline');},close(){}};
 const rag=createRag({enabled:true,maxRecords:8192,sendContextToGenerator:true},{client});
 try {
  const events=Array.from({length:320},(_,i)=>event('user/message',i,{content:[{type:'text',text:i===0?'中文重要约束：只在隔离副本验证 Q8，password=hidden':'无关日常闲聊 '+i}]}));
  rag.sync('a',events);rag.sync('b',[event('user/message',1,{content:'B_PRIVATE_ONLY'})]);await rag.idle();
  const got=await rag.retrieve('a','中文重要约束 Q8 隔离');assert.equal(got.mode,'lexical');assert.ok(got.records.some(r=>r.seq===0));assert.doesNotMatch(JSON.stringify(got),/B_PRIVATE_ONLY|hidden/);
  rag.forget('a');assert.equal(rag.records('a').length,0);assert.equal((await rag.retrieve('a','Q8')).records.length,0);
 } finally {rag.close();}
});
test('local embedding transport refuses redirects and malformed vector dimensions',async()=>{
 let redirect=true;const server=http.createServer((req,res)=>{req.resume();if(redirect){res.writeHead(302,{Location:'https://remote.test/'}).end();}else{res.setHeader('Content-Type','application/json');res.end('{"data":[{"index":0,"embedding":[1,2]}]}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const client=createEmbeddingClient({endpoint:`http://127.0.0.1:${server.address().port}/v1/embeddings`});
 try {await assert.rejects(client.embed(['test']));redirect=false;await assert.rejects(client.embed(['test']));} finally{client.close();await new Promise(resolve=>server.close(resolve));}
});
