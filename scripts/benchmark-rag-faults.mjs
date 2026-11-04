import http from 'node:http';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
if (!process.env.DSH_AB_BRIDGE || !process.env.DSH_AB_LLM_MODULE || !process.env.DSH_AB_OUTPUT) throw Error('Set explicit adapter, LLM module and output paths; see docs/q8-rag-ab-validation.md');
const out=pathToFileURL(resolve(process.env.DSH_AB_OUTPUT)+'/');await mkdir(out,{recursive:true});
import {performance} from 'node:perf_hooks';
import {createRag,createEmbeddingClient} from '../host/rag.js';
import {validateProgress} from '../host/progress.js';
import {abFixtures} from '../support/ab-fixtures.js';
const {connectCurrentModel}=await import(pathToFileURL(resolve(process.env.DSH_AB_BRIDGE)));
const {createUserMessage}=await import(pathToFileURL(resolve(process.env.DSH_AB_LLM_MODULE)));
let mode='healthy',requests=0;const open=new Set();
const server=http.createServer((req,res)=>{requests++;req.resume();let body='';req.on('data',c=>body+=c);req.on('end',()=>{
 if(mode==='503'){res.writeHead(503).end('synthetic unavailable');return;}
 if(mode==='malformed'){res.setHeader('Content-Type','application/json');res.end('{"data":[{"index":0,"embedding":[1,2]}]}');return;}
 if(mode==='delay')return;
 const upstream=http.request('http://127.0.0.1:11434/v1/embeddings',{method:'POST',headers:{'Content-Type':'application/json'}},r=>{res.writeHead(r.statusCode,{'Content-Type':'application/json'});r.pipe(res);});
 upstream.on('error',()=>{if(!res.destroyed)res.writeHead(502).end();});res.on('close',()=>upstream.destroy());upstream.end(body);
});});
server.on('connection',s=>{open.add(s);s.on('close',()=>open.delete(s));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/v1/embeddings`,f=abFixtures().find(f=>f.name==='write-only');
const rag=createRag({enabled:true,strategy:'typed',endpoint,embeddingTimeoutMs:400,retrievalTimeoutMs:250});
const result={startedAt:new Date().toISOString(),faults:[],endpoint:'loopback fault proxy -> existing Ollama',synthetic:true};
let model;
try{
 rag.sync(f.sessionId,f.events);await rag.idle();assert.ok(rag.stats().vectors>0);
 for(const fault of ['503','delay','malformed','healthy']){
  mode=fault;const start=performance.now();const r=await rag.retrieve(f.sessionId,f.query+' '+fault,{purpose:'evidence',completions:[f.plan.steps[0].completion]});
  const checked=validateProgress({op:'patch',changes:[{id:'s1',status:'done',evidence:r.records.map(x=>x.id)}]},f.plan,rag.records(f.sessionId)).output.changes[0];
  assert.notEqual(checked.status,'done');assert.match(JSON.stringify(r.constraints),/禁止修改生产配置/);
  assert.equal(r.mode,fault==='healthy'?'hybrid':'lexical');
  result.faults.push({fault,elapsedMs:performance.now()-start,mode:r.mode,status:checked.status,constraintsRetained:true});
 }
 // Empty index: exhaust actual bounded background retries, restore endpoint,
 // wait the real cooldown, then recover with the same history and a new query.
 mode='503';const cold=createRag({enabled:true,strategy:'typed',endpoint,embeddingTimeoutMs:400});
 try{
  const before=requests;cold.sync('cold',[{seq:1,type:'user/message',data:{content:'禁止修改生产配置，仅做合成测试'}}]);await cold.idle();
  await new Promise(r=>setTimeout(r,2600));await cold.idle();const attempts=requests-before;assert.equal(attempts,3);
  mode='healthy';const start=performance.now();await new Promise(r=>setTimeout(r,30300));await cold.retrieve('cold','恢复查询');await cold.idle();
  const recovered=await cold.retrieve('cold','恢复查询');assert.equal(recovered.mode,'hybrid');assert.ok(cold.stats().vectors>0);
  result.cooldown={failedBackgroundAttempts:attempts,waitAndRecoveryMs:performance.now()-start,newHistoryEvents:0,mode:recovered.mode};
 }finally{cold.close();}
 model=await connectCurrentModel();
 const request={provider:model.selection.provider,model:model.selection.model,reasoningEffort:'off',maxTokens:1000,temperature:0,
 system:'合成隔离故障恢复测试。只处理本消息。',messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请依次输出从 1 到 500 的整数，用逗号分隔。'}]})]};
 const controller=new AbortController();let cancelled=false,first=false;const t=performance.now();

 try{for await(const chunk of model.llm.stream({...request,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])})){
  if(chunk.type==='text-delta'&&!first){first=true;controller.abort();}
 }}catch{cancelled=true;}
 assert.ok(first&&controller.signal.aborted);
 result.generationAbort={firstTextReceived:first,abortRequested:true,iteratorThrew:cancelled,elapsedMs:performance.now()-t};
 const rt=performance.now();let text='';for await(const chunk of model.llm.stream({...request,maxTokens:64,messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请只输出 {"ok":true}。'}]})],signal:AbortSignal.timeout(15000)})){if(chunk.type==='text-delta')text+=chunk.text;}
 assert.match(text,/"ok"\s*:\s*true/);result.generationRecovery={elapsedMs:performance.now()-rt,text};result.unchanged=await model.unchanged();assert.equal(result.unchanged,true);result.metadata=model.metadata;
 result.pass=true;
}catch(error){result.pass=false;result.error=error.message;process.exitCode=1;}
finally{rag.close();model?.close();for(const s of open)s.destroy();await new Promise(r=>server.close(r));await writeFile(new URL('faults.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
