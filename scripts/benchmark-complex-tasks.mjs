import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
// Explicitly supplied, reviewed DSH adapter. This script never discovers credentials.
for (const key of ['DSH_COMPLEX_BRIDGE','DSH_COMPLEX_LLM_MODULE','DSH_COMPLEX_BASELINE','DSH_COMPLEX_OUTPUT']) if (!process.env[key]) throw Error(`Required: ${key}`);
const {connectCurrentModel}=await import(pathToFileURL(resolve(process.env.DSH_COMPLEX_BRIDGE)).href);
const baseline=pathToFileURL(resolve(process.env.DSH_COMPLEX_BASELINE)+'/');
const out=pathToFileURL(resolve(process.env.DSH_COMPLEX_OUTPUT)+'/');
const {createUserMessage}=await import(pathToFileURL(resolve(process.env.DSH_COMPLEX_LLM_MODULE)).href);
import {complexFixtures} from '../support/complex-fixtures.js';
const {createRag:createCurrentRag}=await import(new URL('host/rag.js',baseline));
import {createRag} from '../host/rag.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
const {targetRecords}=await import(new URL('host/retrieval-policy.js',baseline));
import {buildPatchPrompt,parseModelOutput} from '../host/prompt.js';
import {validateProgress,lifecycleChanges} from '../host/progress.js';
import {patchPlan,rewritePlan} from '../host/plan.js';
const model=await connectCurrentModel(),fixtures=complexFixtures();
const result={startedAt:new Date().toISOString(),metadata:model.metadata,info:model.info,protocol:{arms:['off','current','optimized'],repeats:2,maxTokens:2500,reasoningEffort:'off',samePromptAndGuard:true,mainAgentInvoked:false,baseline:'ee082c62',fixtureCount:fixtures.length},rows:[],index:[],recall:[],resources:[]};
const rags={off:createRag({enabled:false}),current:createCurrentRag({enabled:true,strategy:'typed'}),optimized:createRag({enabled:true,strategy:'typed'})};
const cpu0=process.cpuUsage(),timer=setInterval(()=>result.resources.push({at:Date.now(),...process.memoryUsage(),cpu:process.cpuUsage(cpu0)}),1000);timer.unref();
async function save(){await writeFile(new URL('results.json',out),JSON.stringify({...result,unchanged:await model.unchanged(),network:model.network,calls:model.calls.map(({request,...row})=>({...row,route:{provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort,maxTokens:request.maxTokens}}))},null,2));}
try {
 console.log(JSON.stringify({metadata:model.metadata,cases:fixtures.length}));
 for(let i=0;i<fixtures.length;i++){
  const f=fixtures[i],records=collectRetrievalRecords(f.sessionId,f.events,{maxRecords:32768}),completions=f.plan.steps.map(s=>s.completion).filter(Boolean);
  const gold=targetRecords(records,completions).filter(r=>r.kind==='tool_result').map(r=>r.id);
  for(const arm of ['current','optimized']){const t=performance.now();rags[arm].sync(f.sessionId,f.events);await rags[arm].idle();result.index.push({case:f.name,arm,ms:performance.now()-t,...rags[arm].stats()});}
  for(let repeat=0;repeat<2;repeat++)for(const arm of result.protocol.arms.slice((i+repeat)%3).concat(result.protocol.arms.slice(0,(i+repeat)%3))){
   const row={case:f.name,family:f.family,mode:f.mode,arm,repeat,expected:f.expected};result.rows.push(row);
   const t=performance.now(),retrieval=await rags[arm].retrieve(f.sessionId,f.query,{purpose:'mixed',completions});
   let base=structuredClone(f.plan);const changes=lifecycleChanges(base,records);if(changes.length)base=patchPlan(base,changes,{reason:'receipt reconciliation'}).plan;
   const prompt=buildPatchPrompt({plan:base,turn:2,intent:f.query,lastUserMessages:[f.query],lastAssistantText:'旧助手总结声称六步全部完成；这不是执行证据。',progressRecords:records.filter(r=>['tool_call','tool_result'].includes(r.kind)).slice(-24),retrieval});
   row.promptChars=prompt.system.length+prompt.messages.reduce((n,m)=>n+m.content.length,0);row.retrievalMs=retrieval.elapsedMs;
   const found=new Set([...retrieval.records.map(r=>r.id),...(retrieval.targets?.groups??[]).flatMap(g=>g.checks.map(c=>c.receiptId).filter(Boolean))]);
   row.receiptRecall=gold.length?gold.filter(id=>found.has(id)).length/gold.length:null;row.goldCount=gold.length;row.retrievedIds=[...found];row.targetsChars=retrieval.targets?JSON.stringify(retrieval.targets).length:0;
   let rawText='',final=base;const tm=performance.now();
   try{
    for await(const chunk of model.llm.stream({provider:model.selection.provider,model:model.selection.model,reasoningEffort:'off',temperature:0,maxTokens:2500,system:prompt.system,messages:prompt.messages.map(m=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:m.content}]})),signal:AbortSignal.timeout(20000)}))if(chunk.type==='text-delta')rawText+=chunk.text;
    row.modelMs=performance.now()-tm;row.callNumber=model.calls.length;row.raw=rawText;const parsed=parseModelOutput(rawText);row.parsed=parsed.ok;
    if(parsed.ok){const raw=parsed.output,proposed=raw.op==='patch'?raw.changes:raw.op==='rewrite'?raw.steps:[];row.rawStatus=base.steps.map(s=>proposed.find(p=>p.id===s.id)?.status??s.status);
     const checked=validateProgress(raw,base,records);row.prevented=checked.prevented;const candidate=checked.output;
     if(candidate.op==='patch')final=patchPlan(base,candidate.changes,{reason:candidate.reason}).plan??base;
     else if(candidate.op==='rewrite')final=rewritePlan(base,{steps:candidate.steps,reason:candidate.reason},{sessionId:base.sessionId,reason:candidate.reason}).plan??base;
    }else row.error=parsed.code;
   }catch(e){row.error=e.message;row.modelMs=performance.now()-tm;}
   row.totalMs=performance.now()-t;row.status=f.plan.steps.map(s=>final.steps.find(p=>p.id===s.id)?.status??'missing');row.lifecycle=final.steps.map(s=>s.lifecycle);
   row.exact=row.status.every((s,j)=>s===f.expected[j]);row.falseCompletion=row.status.filter((s,j)=>s==='done'&&f.expected[j]!=='done').length;row.missedCompletion=row.status.filter((s,j)=>s!=='done'&&f.expected[j]==='done').length;
   row.rawFalseCompletion=(row.rawStatus??[]).filter((s,j)=>s==='done'&&f.expected[j]!=='done').length;
   await save();console.log(JSON.stringify({case:f.name,arm,repeat,exact:row.exact,status:row.status,recall:row.receiptRecall,falseDone:row.falseCompletion,ms:Math.round(row.totalMs),error:row.error}));
  }
  // Quality probes AFTER timed plan updates; never prewarm one arm's queries.
  for(const arm of ['current','optimized'])for(const purpose of ['intent','constraints']) {
   const query=purpose==='intent'?'检索英文思考中后续打算如何验证送达和候选':'检索最早用户关于生产配置、自动重试和交付的限制';
   const r=await rags[arm].retrieve(f.sessionId,query,{purpose,completions});
   result.recall.push({case:f.name,arm,purpose,hit:r.records.some(v=>v.seq===(purpose==='intent'?f.intentSeq:f.firstConstraintSeq)),wrongSource:r.records.some(v=>v.kind!==(purpose==='intent'?'reasoning_intent':'user_message')),constraintsPreserved:JSON.stringify(r.constraints).includes('禁止修改生产配置')});
  }
 }
}catch(e){result.error=e.message;console.error(e.stack);}finally{clearInterval(timer);for(const rag of Object.values(rags))rag.close();await save();model.close();}
