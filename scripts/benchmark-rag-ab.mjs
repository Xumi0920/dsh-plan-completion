import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
if (!process.env.DSH_AB_BRIDGE || !process.env.DSH_AB_LLM_MODULE || !process.env.DSH_AB_OUTPUT) throw Error('Set DSH_AB_BRIDGE, DSH_AB_LLM_MODULE and DSH_AB_OUTPUT explicitly; see docs/q8-rag-ab-validation.md');
const {connectCurrentModel}=await import(pathToFileURL(resolve(process.env.DSH_AB_BRIDGE)));
const {createUserMessage}=await import(pathToFileURL(resolve(process.env.DSH_AB_LLM_MODULE)));
import {abFixtures} from '../support/ab-fixtures.js';
import {createRag} from '../host/rag.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {buildPatchPrompt,parseModelOutput} from '../host/prompt.js';
import {validateProgress,lifecycleChanges} from '../host/progress.js';
import {patchPlan,rewritePlan} from '../host/plan.js';
const out=pathToFileURL(resolve(process.env.DSH_AB_OUTPUT)+'/');await mkdir(out,{recursive:true});
const model=await connectCurrentModel(), fixtures=abFixtures();
const result={startedAt:new Date().toISOString(),metadata:model.metadata,info:model.info,protocol:{arms:['off','hybrid','typed'],repeats:2,queryPurpose:'explicit fixture purpose for retrieval-only; mixed with existing targets for plan generation',embedding:'official Q8_0 unchanged',maxTokens:1000,reasoningEffort:'off',modelDeadlineMs:15000,mainAgentInvoked:false},rows:[],index:[],resources:[]};
const rags={off:createRag({enabled:false}),hybrid:createRag({enabled:true,strategy:'hybrid'}),typed:createRag({enabled:true,strategy:'typed'})};
const cpu0=process.cpuUsage();const timer=setInterval(()=>result.resources.push({at:Date.now(),...process.memoryUsage(),cpu:process.cpuUsage(cpu0)}),1000);timer.unref();
async function save(){await writeFile(new URL('results.json',out),JSON.stringify({...result,unchanged:await model.unchanged(),network:model.network,calls:model.calls.map(({request,...c})=>({...c,route:{provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort,maxTokens:request.maxTokens}}))},null,2));}
try{
 console.log(JSON.stringify({metadata:model.metadata,cases:fixtures.length}));
 for(let i=0;i<fixtures.length;i++){
  const f=fixtures[i], records=collectRetrievalRecords(f.sessionId,f.events,{maxRecords:32768});
  for(const arm of ['hybrid','typed']){const t=performance.now();rags[arm].sync(f.sessionId,f.events);await rags[arm].idle();result.index.push({case:f.name,arm,ms:performance.now()-t,...rags[arm].stats()});}
  for(let repeat=0;repeat<2;repeat++)for(const arm of result.protocol.arms.slice((i+repeat)%3).concat(result.protocol.arms.slice(0,(i+repeat)%3))){
   const rag=rags[arm];const row={case:f.name,arm,repeat,expected:f.expectedStatus};result.rows.push(row);
   const t=performance.now();
   const retrieval=await rag.retrieve(f.sessionId,f.query,{purpose:'mixed',completions:[f.plan.steps[0].completion]});
   let base=structuredClone(f.plan);const lifecycle=lifecycleChanges(base,records);if(lifecycle.length)base=patchPlan(base,lifecycle,{reason:'receipt reconciliation'}).plan;
   const prompt=buildPatchPrompt({plan:base,turn:2,intent:f.query,lastUserMessages:[f.query+' 保持原有步骤标题、id及验收目标。'],lastAssistantText:'助手声称完成全部工作；这不是执行回执。',progressRecords:records.filter(r=>r.kind==='tool_call'||r.kind==='tool_result').slice(-24),retrieval});
   let text='';const modelStart=performance.now();
   try{
    for await(const chunk of model.llm.stream({provider:model.selection.provider,model:model.selection.model,reasoningEffort:'off',temperature:0,maxTokens:1000,system:prompt.system,messages:prompt.messages.map(m=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:m.content}]})),signal:AbortSignal.timeout(15000)})){if(chunk.type==='text-delta')text+=chunk.text;}
    row.modelMs=performance.now()-modelStart;row.callNumber=model.calls.length;row.raw=text;const parsed=parseModelOutput(text);row.parsed=parsed.ok;
    if(parsed.ok){const raw=parsed.output, proposed=(raw.op==='patch'?raw.changes:raw.op==='rewrite'?raw.steps:[]).find(s=>s.id==='s1');row.rawStatus=proposed?.status??base.steps[0].status;const checked=validateProgress(raw,base,records);row.prevented=checked.prevented;
     const candidate=checked.output;let final=base;if(candidate.op==='patch')final=patchPlan(base,candidate.changes,{reason:candidate.reason}).plan??base;else if(candidate.op==='rewrite')final=rewritePlan(base,{steps:candidate.steps,reason:candidate.reason},{sessionId:base.sessionId,reason:candidate.reason}).plan??base;
     row.finalStatus=final.steps.find(s=>s.id==='s1')?.status??'missing';row.finalLifecycle=final.steps.find(s=>s.id==='s1')?.lifecycle;
    }else{row.error=parsed.code;row.finalStatus=base.steps[0].status;}
   }catch(e){row.error=e.message;row.finalStatus=base.steps[0].status;row.modelMs=performance.now()-modelStart;}
   row.totalMs=performance.now()-t;row.planRetrievalMs=retrieval.elapsedMs;
   const recalled=await rag.retrieve(f.sessionId,f.query,{purpose:f.purpose,completions:[f.plan.steps[0].completion]});
   const found=new Set(recalled.records.map(r=>r.seq));row.recall=f.goldSeqs.length?f.goldSeqs.filter(seq=>found.has(seq)).length/f.goldSeqs.length:null;row.retrievalMs=recalled.elapsedMs;row.retrievalMode=recalled.mode;row.retrievedSeqs=[...found];row.retrievedKinds=recalled.records.map(r=>r.kind);
   row.wrongSourceCount=recalled.records.filter(r=>f.purpose==='intent'?r.kind!=='reasoning_intent':f.purpose==='constraints'?r.kind!=='user_message':f.purpose==='evidence'?!['tool_call','tool_result'].includes(r.kind):false).length;
   row.falseCompletion=row.finalStatus==='done'&&f.expectedStatus!=='done';row.rawFalseCompletion=row.rawStatus==='done'&&f.expectedStatus!=='done';row.missedCompletion=f.expectedStatus==='done'&&row.finalStatus!=='done';row.exact=row.finalStatus===f.expectedStatus;
   await save();console.log(JSON.stringify({case:f.name,arm,repeat,recall:row.recall,status:row.finalStatus,expected:row.expected,ms:Math.round(row.totalMs),error:row.error}));
  }
 }
}catch(e){result.error=e.message;console.error(e.stack);}finally{clearInterval(timer);for(const rag of Object.values(rags))rag.close();await save();model.close();}
