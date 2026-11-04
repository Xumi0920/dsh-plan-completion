import {readFile,writeFile,mkdir,symlink,realpath} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
// Only explicitly supplied isolated runtime/adapter paths are used.
for(const key of ['DSH_PROTOCOL_RUNTIME','DSH_PROTOCOL_BRIDGE','DSH_PROTOCOL_OUTPUT'])if(!process.env[key])throw Error('Required: '+key);
const runtime=pathToFileURL(resolve(process.env.DSH_PROTOCOL_RUNTIME)+'/');
const outputRoot=resolve(process.env.DSH_PROTOCOL_OUTPUT);
const checkout=await realpath(fileURLToPath(new URL('..',import.meta.url)));
const runtimePlugin=await realpath(fileURLToPath(new URL('node_modules/dsh-plan-completion',runtime)));
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
if(!samePath(checkout,runtimePlugin))throw Error('Runtime plugin must resolve to this checkout; refusing mismatched source hashes');
const {boot,loadOptionalPatches,composeEntries}=await import(new URL('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',runtime));
const {assertReleasedV4Relationships}=await import(new URL('node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js',runtime));
const {createUserMessage}=await import(new URL('node_modules/@deepseek-ai/dsh-llm/lib/index.js',runtime));
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {collectConstraintAnchors} from '../host/constraint-memory.js';
const {connectCurrentModel}=await import(pathToFileURL(resolve(process.env.DSH_PROTOCOL_BRIDGE)).href);
import {complexFixtures} from '../support/complex-fixtures.js';
const mode=process.env.DSH_PROTOCOL_RAG==='off'?'off':'q8',run=process.env.DSH_LONG_RUN??'r1',suffix='-'+run;
if(!/^[a-z0-9-]{1,24}$/.test(run))throw Error('invalid-run');
const path=p=>resolve(outputRoot,p),project=path('./simulator-project-'+mode+suffix),home=path('./native-home-'+mode+suffix);
await mkdir(outputRoot,{recursive:true});await mkdir(home);await symlink(fileURLToPath(new URL('node_modules',runtime)),resolve(home,'node_modules'),process.platform==='win32'?'junction':'dir');
await mkdir(project);await writeFile(resolve(project,'production-sentinel.json'),'synthetic long-test sentinel\n');await writeFile(resolve(home,'cordis.yml'),'[]\n');
process.env.DSH_SYNTHETIC_EAGER_TOOLS='1';const model=await connectCurrentModel();
process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1';
let outputCap=4096;const nativeOutputCap=model.info.defaultMaxTokens??256000,testInfo={...model.info,defaultMaxTokens:outputCap};
const pkg=fileURLToPath(new URL('node_modules/@deepseek-ai/',runtime));
const patches=[...loadOptionalPatches('full-task',path(pkg+'dsh-base/cordis.patch.yml')),...loadOptionalPatches('full-task',path(pkg+'dsh-web-app/cordis.patch.yml'))];
for(const row of composeEntries([patches]))if(row.id.startsWith('tool-')||['deepseek-account','llm-deepseek-account','llm-deepseek','llm-pi-ai','session-title-llm','desktop-product-telemetry','product-analytics'].includes(row.id))patches.push({id:row.id,disabled:true});
patches.push({id:'agent-default-model',config:model.selection},
{insert:[{id:'preset-standard',name:'@deepseek-ai/dsh-agent-preset',config:{id:'standard',order:1,plugins:[{id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:'You are executing an isolated synthetic workflow simulator, using only the provided exec tool with exact command identifiers. No shell, external messages or private data are involved. Follow Chinese requirements and distinguish actual simulator receipts from intent or summaries.'}},{id:'compaction',name:'cordis:group',group:true,isolate:{compaction:true,toolResultPruner:true},config:[{id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic'},{id:'command-compact',name:'@deepseek-ai/dsh-command-compact'},{id:'tool-result-pruner',name:'@deepseek-ai/dsh-compaction-tool-result-pruner',config:{thresholdChars:8192,headChars:4096,tailChars:1024}}]}]}}]},
{id:'web-runtime',config:{openBrowser:false,printUrl:false,surfaceContext:true}},
{insert:[{id:'plan-completion',name:'dsh-plan-completion',config:{modelCalls:true,persistPlans:true,storageDir:path('./native-home-'+mode+suffix+'/plan-data'),debugDir:path('./native-debug-'+mode+suffix),enableDebugRoutes:false,warmBackfill:false,maxTokensPatch:2500,maxTokensRewrite:2500,rag:{enabled:mode!=='off',sendContextToGenerator:mode!=='off',strategy:'typed'}}}]});
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const sourceFiles={};
for(const file of ['index.js','host/acceptance.js','host/plan.js','host/progress-schema.js','host/progress-protocol.js','host/progress.js','host/prompt.js','host/rag.js','host/rag-evidence.js','host/retrieval-policy.js'])sourceFiles[file]=hash((await readFile(new URL('../'+file,import.meta.url),'utf8')).replace(/\r\n/g,'\n'));
const protectedPaths=['production-sentinel.json'];
const before=Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,hash(await readFile(resolve(project,p)))])));
let simulator=new Map(), family='', phase='';
const result={startedAt:new Date().toISOString(),metadata:model.metadata,info:model.info,sourceFiles,outputCap,nativeOutputCap,compactionPolicy:'native defaults: thresholdRatio=.8, headroom=65536, retainRatio=.16, summary cap=65536; no forced compact',phases:[],toolExecutions:[],resources:[],protectedBefore:before,seededAcceptance:true};
const cpu0=process.cpuUsage();const samples=setInterval(()=>result.resources.push({at:Date.now(),...process.memoryUsage(),cpu:process.cpuUsage(cpu0)}),1000);samples.unref();
const requestViews=[];let ctx,agent,session;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function save(){await writeFile(path('./native-'+mode+suffix+'-result.json'),JSON.stringify({...result,calls:model.calls.map(({request,...c})=>({...c,route:{provider:request.provider,model:request.model,maxTokens:request.maxTokens,reasoningEffort:request.reasoningEffort,purpose:request.purpose}})),network:model.network,productionUnchanged:await model.unchanged()},null,2));}
async function runPhase(label,text,lines=0,expected,expectedRevisions,cycle=0){
 phase=label;
 const start=performance.now(),startSeq=session.seq,oldCalls=model.calls.length;
 console.log(JSON.stringify({start:label,lines,startSeq}));
 if(lines)for(let at=0;at<lines;at+=1000){const corpus=Array.from({length:Math.min(1000,lines-at)},(_,i)=>`Synthetic archive ${cycle}-${at}-${i}: module cedar receives alpha beta gamma and returns delta epsilon zeta. Diagnostic category neutral; sample label meadow; checksum ${i%997}.`).join('\n');agent.inject(createUserMessage({source:{kind:'user'},content:[{type:'text',text:corpus}]}));}
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));
 let settled=false;for(let n=0;n<660;n++){await sleep(1000);const log=[...session.snapshotEvents(startSeq)];if(agent.status==='idle'&&log.some(e=>e.type==='turn/end')&&model.calls.length>oldCalls&&model.calls.every(c=>'elapsedMs'in c)){await sleep(3000);if(agent.status==='idle'&&model.calls.every(c=>'elapsedMs'in c)){settled=true;break;}}}
 if(!settled)throw Error('phase-timeout:'+label);
 const events=[...session.snapshotEvents()],state=structuredClone(ctx.get('planCompletion').states.get(session.id));
 let valid=true,error;try{assertReleasedV4Relationships({header:session.header,events,inheritedEventCount:session.inheritedEventCount},new Set(events.map(e=>e.type)))}catch(e){valid=false;error=e.message;}
 const acceptanceRevisions=state?.plan?.steps?.map(s=>s.acceptance?.revision),statuses=state?.plan?.steps?.map(s=>s.status),row={label,elapsedMs:performance.now()-start,startSeq,endSeq:session.seq,statuses,expected,acceptanceRevisions,expectedRevisions,exact:expected?JSON.stringify(statuses)===JSON.stringify(expected)&&(!expectedRevisions||JSON.stringify(acceptanceRevisions)===JSON.stringify(expectedRevisions)):null,state,requestViews:requestViews.filter(v=>v.phase===label),outputCap,rawRecordCount:collectRetrievalRecords(session.id,events,{maxRecords:32768}).length,nativeLogValid:valid,nativeLogError:error,compactions:events.filter(e=>e.type==='compaction/summary').length,calls:model.calls.length-oldCalls,constraints:collectConstraintAnchors(session.id,events)};
 result.phases.push(row);await save();console.log(JSON.stringify({end:label,ms:Math.round(row.elapsedMs),statuses,expected,exact:row.exact,compactions:row.compactions,calls:row.calls,valid}));
}
try{
 ctx=await boot('full-task',resolve(home,'cordis.yml'),patches,async c=>{
  c.provide('webStartup',{host:'127.0.0.1',port:mode==='off'?18111:18112,openBrowser:false,trustedHosts:[]});
  c.inject(['tools'],async inner=>{const{defineTool}=await import(new URL('node_modules/@deepseek-ai/dsh-tools/lib/index.js',runtime));
   const specs=[{name:'exec',description:'Execute one named operation in the isolated workflow simulator. This is NOT a system shell. It never contacts QQ, Feishu, or article services. Only exact registered command identifiers are supported; values represent synthetic workflow state.',parameters:{command:{type:'string',required:true}},execute:async args=>{
     if(!simulator.has(args.command))throw Error('simulator-command-not-allowlisted');
     const value=structuredClone(simulator.get(args.command));
     await writeFile(resolve(project,'last-operation.json'),JSON.stringify({family,phase,command:args.command,value}));
     return value;
   }}];
   for(const spec of specs){const execute=spec.execute;spec.execute=async args=>{const start=performance.now();try{const value=await execute(args);result.toolExecutions.push({tool:spec.name,args:spec.name==='write_file'?{path:args.path,contentSha256:hash(args.content)}:args,result:value,ms:performance.now()-start});return value;}catch(e){result.toolExecutions.push({tool:spec.name,args,error:e.message,ms:performance.now()-start});throw e;}};inner.tools.register(defineTool({...spec,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}}));}
  });
  c.inject(['llm'],inner=>{const adapter=Object.create(model.adapter);adapter.resolveModel=async()=>testInfo;const stream=request=>{
     const view={phase,at:Date.now(),reasoningEffort:request.reasoningEffort,maxTokens:request.maxTokens??outputCap,messageCount:request.messages?.length??0};
     if(request.maxTokens===2500){try{const text=request.messages.flatMap(m=>m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');const match=text.match(/```json\n([\s\S]*?)\n```/);const e=JSON.parse(match[1]);view.helper={retrievalMode:e.retrieval?.mode,retrievalMs:e.retrieval?.elapsedMs,indexed:e.retrieval?.indexed,recordCount:e.retrieval?.records?.length,sourceKinds:[...new Set((e.retrieval?.records??[]).map(r=>r.kind))],constraintCount:e.retrieval?.constraints?.records?.length??0,constraintsIncomplete:e.retrieval?.constraints?.incomplete??false,protectedConstraint:JSON.stringify(e.retrieval?.constraints??{}).includes('禁止修改生产配置'),versions:e.progressProtocol?.steps?.map(s=>s.acceptance_revision)};}catch{view.helperParseFailed=true;}}
     requestViews.push(view);
     return model.llm.stream({...request,maxTokens:request.maxTokens??outputCap,signal:AbortSignal.any([...(request.signal?[request.signal]:[]),AbortSignal.timeout(600000)])});
   };adapter.stream=stream;adapter.prepareCall=async()=>({model:testInfo,stream});adapter.listModels=async()=>[testInfo];inner.llm.registerAdapter([model.selection.provider],adapter);});
 },new URL('package.json',runtime).href);
 await sleep(2000);
 const workspace=await ctx.get('workspaceRegistry').resolveByPath(project)??await ctx.get('workspaceRegistry').create(project);
 for(const which of ['qq','workflow']) {
   outputCap=4096;testInfo.defaultMaxTokens=outputCap;family=which;const fixture=complexFixtures().find(f=>f.name===which+'-complete');
   const id='native-protocol-'+mode+suffix+'-'+which;await ctx.get('sessionController').create({sessionId:id,workspaceId:workspace.id});agent=(await ctx.get('sessionController').resolveAgent(id)).agent;session=agent.session;
   const plan=structuredClone(fixture.plan);plan.sessionId=id;simulator=new Map();
   plan.steps=plan.steps.map((s,i)=>{const reqs=(s.completion.all??[s.completion]).map((r,j)=>{
     const command=`${which}:s${i+1}:check${j+1}`;
     simulator.set(command,{ok:true,...(r.expect?{[r.expect.field]:r.expect.equals}:{}),environment:'isolated-synthetic-simulator'});
     return {tool:'exec',args:{command},...(r.expect?{expect:r.expect}:{})};
   });return {...s,completion:reqs.length===1?reqs[0]:{all:reqs},acceptance:{scope:['assertion','assertion','assertion','deployment','delivery','assertion'][i],revision:1,afterSeq:-1,dependsOn:i?[{stepId:plan.steps[i-1].id,revision:1}]:[]}};});
   const host=ctx.get('planCompletion');await host.store.put(plan,{cas:null});host.states.set(id,{plan,suggestion:null,stale:false});
   const commands=indices=>indices.flatMap(i=>(plan.steps[i].completion.all??[plan.steps[i].completion]).map(r=>r.args.command));
   const execute=indices=>'依次调用 exec，每个 command 严格等于以下标识，每项一次：'+commands(indices).join('、')+'。只操作这些模拟器命令，简短报告实际回执，不能推断其他步骤完成，不做真实发送或重试。';
   const done=['done','done','done','done','done','done'],v1=[1,1,1,1,1,1],v2=[1,2,2,2,2,2];
   await runPhase(which+'-initial','这是独立合成的长任务。关键约束：仅操作隔离副本；禁止修改生产配置；不上传真实会话；不合并 PR。保留 DSH 原生上下文管理与自动压缩；思考和摘要不是执行证据。'+execute([0,1,2,3,4,5]),0,done,v1);
   const filler='以上都是合成无关档案，不是执行回执。English intent note: I intend to verify the new artifact, deployment, delivery and duplicates; intention is not execution. 保留现有计划和验收定义，简短中文说明，禁止调用工具。';
   await runPhase(which+'-near1m-1',filler,27000,done,v1,1);
   await runPhase(which+'-auto-1-upstream','受控的上游重写演练。'+execute([1]),0,['done','done','doing','blocked','blocked','blocked'],v1);
   await runPhase(which+'-reverify-1','只读复核上游改变后的下游。'+execute([2,3,4,5]),0,done,v1);
   await runPhase(which+'-near1m-2',filler,22000,done,v1,2);
   const newReqs=(plan.steps[1].completion.all??[plan.steps[1].completion]).map(r=>{const command=r.args.command+':v2';simulator.set(command,structuredClone(simulator.get(r.args.command)));return {...r,args:{command}};});
   const newCompletion=newReqs.length===1?newReqs[0]:{all:newReqs};
   await runPhase(which+'-auto-2-revise','本轮不调用工具。请通过 acceptance_proposed 修改 s2，当前验收版本1；保持 scope=assertion、dependsOn=[{stepId:"s1",revision:1}]，completion 改为 '+JSON.stringify(newCompletion)+'。宿主递增为2，旧回执不得用于新版。其他步骤保持不变。',0,['done','todo','blocked','blocked','blocked','blocked'],[1,2,1,1,1,1]);
   plan.steps[1].completion=newCompletion;
   await runPhase(which+'-rebind-2','本轮不调用工具。s2 已为验收版本2；在同一个 progress.events 中按 s3→s4→s5→s6 顺序提交全部四个 acceptance_proposed。各步当前验收版本1，仅将对应前置步骤的 revision 更新为2，保持 scope、completion、依赖 stepId 不变。宿主各递增为2，旧回执不追认。',0,['done','todo','blocked','blocked','blocked','blocked'],v2);
   await runPhase(which+'-execute-v2','执行新版验收。'+execute([1,2,3,4,5]),0,done,v2);
   await runPhase(which+'-near1m-3',filler,22000,done,v2,3);
   const fail=commands([2]).at(-1),success=simulator.get(fail);simulator.set(fail,{ok:false,error:'SYNTHETIC_UPSTREAM_FAILURE'});
   await runPhase(which+'-auto-3-failure','仅调用 exec command="'+fail+'" 一次，记录故障后停止，不自动重试。',0,['done','done','blocked','blocked','blocked','blocked'],v2);
   simulator.set(fail,success);
   await runPhase(which+'-recover-3','模拟器已恢复，仅重新检查，不发送任何消息。'+execute([2,3,4,5]),0,done,v2);
   outputCap=nativeOutputCap;testInfo.defaultMaxTokens=outputCap;
   await runPhase(which+'-native-reserve-fill',filler,15000,done,v2,4);
   await runPhase(which+'-native-reserve-auto','继续核对现有六个步骤、验收版本与最早隔离约束。保留原生自动压缩机制，不调用工具，简短回复。',0,done,v2);
   const events=[...session.snapshotEvents()];await writeFile(path('./native-'+mode+suffix+'-'+which+'-events.json'),JSON.stringify({header:session.header,events,inheritedEventCount:session.inheritedEventCount}));
 }
 result.protectedAfter=Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,hash(await readFile(resolve(project,p)))])));result.protectedUnchanged=JSON.stringify(before)===JSON.stringify(result.protectedAfter);
 result.finished=true;
 if(result.phases.some(p=>p.exact===false||!p.nativeLogValid)||!result.protectedUnchanged||!await model.unchanged())process.exitCode=1;
}catch(e){result.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{clearInterval(samples);if(agent?.status==='running')agent.cancel({kind:'user'});await save();await ctx?.fiber.dispose();model.close();}

