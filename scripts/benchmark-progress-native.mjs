import {readFile,writeFile,mkdir,symlink} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
// Requires an isolated installed DSH runtime and an explicitly reviewed adapter.
for(const key of ['DSH_PROTOCOL_RUNTIME','DSH_PROTOCOL_BRIDGE','DSH_PROTOCOL_OUTPUT'])if(!process.env[key])throw Error('Required: '+key);
const runtime=pathToFileURL(resolve(process.env.DSH_PROTOCOL_RUNTIME)+'/');
const outputRoot=resolve(process.env.DSH_PROTOCOL_OUTPUT);
const {boot,loadOptionalPatches,composeEntries}=await import(new URL('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',runtime));
const {assertReleasedV4Relationships}=await import(new URL('node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js',runtime));
const {createUserMessage}=await import(new URL('node_modules/@deepseek-ai/dsh-llm/lib/index.js',runtime));
import {normalizePlan} from '../host/plan.js';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {collectConstraintAnchors} from '../host/constraint-memory.js';
const {connectCurrentModel}=await import(pathToFileURL(resolve(process.env.DSH_PROTOCOL_BRIDGE)).href);
import {complexFixtures} from '../support/complex-fixtures.js';
const mode=process.env.DSH_PROTOCOL_RAG==='off'?'off':'q8',suffix=process.env.DSH_PROTOCOL_RUN??'';
if(!['','-final','-validated'].includes(suffix))throw Error('invalid-run-suffix');
const path=p=>resolve(outputRoot,p),project=path('./simulator-project-'+mode+suffix),home=path('./native-home-'+mode+suffix);
await mkdir(outputRoot,{recursive:true});
// Refuse to reuse a previous test session or production state.
await mkdir(home);await symlink(fileURLToPath(new URL('node_modules',runtime)),resolve(home,'node_modules'),process.platform==='win32'?'junction':'dir');
await mkdir(project);await writeFile(resolve(project,'production-sentinel.json'),'synthetic sentinel\n');
await writeFile(resolve(home,'cordis.yml'),'[]\n');
process.env.DSH_SYNTHETIC_EAGER_TOOLS='1';const model=await connectCurrentModel();
process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1';
const outputCap=model.info.defaultMaxTokens??256000,testInfo={...model.info,defaultMaxTokens:outputCap};
const pkg=fileURLToPath(new URL('node_modules/@deepseek-ai/',runtime));
const patches=[...loadOptionalPatches('full-task',path(pkg+'dsh-base/cordis.patch.yml')),...loadOptionalPatches('full-task',path(pkg+'dsh-web-app/cordis.patch.yml'))];
for(const row of composeEntries([patches]))if(row.id.startsWith('tool-')||['deepseek-account','llm-deepseek-account','llm-deepseek','llm-pi-ai','session-title-llm','desktop-product-telemetry','product-analytics'].includes(row.id))patches.push({id:row.id,disabled:true});
patches.push({id:'agent-default-model',config:model.selection},
{insert:[{id:'preset-standard',name:'@deepseek-ai/dsh-agent-preset',config:{id:'standard',order:1,plugins:[{id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:'You are executing an isolated synthetic workflow simulator, using only the provided exec tool with exact command identifiers. No shell, external messages or private data are involved. Follow Chinese requirements and distinguish actual simulator receipts from intent or summaries.'}},{id:'compaction',name:'cordis:group',group:true,isolate:{compaction:true,toolResultPruner:true},config:[{id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic',config:{maxTokens:4096}},{id:'command-compact',name:'@deepseek-ai/dsh-command-compact'},{id:'tool-result-pruner',name:'@deepseek-ai/dsh-compaction-tool-result-pruner',config:{thresholdChars:8192,headChars:4096,tailChars:1024}}]}]}}]},
{id:'web-runtime',config:{openBrowser:false,printUrl:false,surfaceContext:true}},
{insert:[{id:'plan-completion',name:'dsh-plan-completion',config:{modelCalls:true,persistPlans:true,storageDir:path('./native-home-'+mode+suffix+'/plan-data'),debugDir:path('./native-debug-'+mode+suffix),enableDebugRoutes:false,warmBackfill:false,maxTokensPatch:2500,maxTokensRewrite:2500,rag:{enabled:mode!=='off',sendContextToGenerator:mode!=='off',strategy:'typed'}}}]});
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const protectedPaths=['production-sentinel.json'];
const before=Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,hash(await readFile(resolve(project,p)))])));
let simulator=new Map(), family='', phase='';
const result={startedAt:new Date().toISOString(),metadata:model.metadata,info:model.info,outputCap,phases:[],toolExecutions:[],resources:[],protectedBefore:before,seededAcceptance:true};
const samples=setInterval(()=>result.resources.push({at:Date.now(),...process.memoryUsage()}),1000);samples.unref();
let ctx,agent,session;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function save(){await writeFile(path('./native-'+mode+suffix+'-result.json'),JSON.stringify({...result,calls:model.calls.map(({request,...c})=>({...c,route:{provider:request.provider,model:request.model,maxTokens:request.maxTokens,reasoningEffort:request.reasoningEffort,purpose:request.purpose}})),network:model.network,productionUnchanged:await model.unchanged()},null,2));}
async function runPhase(label,text,lines=0,expected,expectedRevisions){
 const start=performance.now(),startSeq=session.seq,oldCalls=model.calls.length;
 console.log(JSON.stringify({start:label,lines,startSeq}));
 if(lines)for(let at=0;at<lines;at+=1000){const corpus=Array.from({length:Math.min(1000,lines-at)},(_,i)=>`Synthetic archive ${label}-${at+i}: module cedar receives alpha beta gamma and returns delta epsilon zeta. Diagnostic category neutral; sample label meadow; checksum ${i%997}.`).join('\n');agent.inject(createUserMessage({source:{kind:'user'},content:[{type:'text',text:corpus}]}));}
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));
 let settled=false;for(let n=0;n<600;n++){await sleep(1000);const log=[...session.snapshotEvents(startSeq)];if(agent.status==='idle'&&log.some(e=>e.type==='turn/end')&&model.calls.length>oldCalls&&model.calls.every(c=>'elapsedMs'in c)){await sleep(3000);if(agent.status==='idle'&&model.calls.every(c=>'elapsedMs'in c)){settled=true;break;}}}
 if(!settled)throw Error('phase-timeout:'+label);
 const events=[...session.snapshotEvents()],state=structuredClone(globalThis.__dsh_plan_completion_host__.states.get(session.id));
 let valid=true,error;try{assertReleasedV4Relationships({header:session.header,events,inheritedEventCount:session.inheritedEventCount},new Set(events.map(e=>e.type)))}catch(e){valid=false;error=e.message;}
 const acceptanceRevisions=state?.plan?.steps?.map(s=>s.acceptance?.revision),statuses=state?.plan?.steps?.map(s=>s.status),row={label,elapsedMs:performance.now()-start,startSeq,endSeq:session.seq,statuses,expected,acceptanceRevisions,expectedRevisions,exact:expected?JSON.stringify(statuses)===JSON.stringify(expected)&&(!expectedRevisions||JSON.stringify(acceptanceRevisions)===JSON.stringify(expectedRevisions)):null,state,nativeLogValid:valid,nativeLogError:error,compactions:events.filter(e=>e.type==='compaction/summary').length,calls:model.calls.length-oldCalls,constraints:collectConstraintAnchors(session.id,events)};
 result.phases.push(row);await save();console.log(JSON.stringify({end:label,ms:Math.round(row.elapsedMs),statuses,expected,exact:row.exact,compactions:row.compactions,calls:row.calls,valid}));
}
try{
 ctx=await boot('full-task',resolve(home,'cordis.yml'),patches,async c=>{
  c.provide('webStartup',{host:'127.0.0.1',port:mode==='off'?18109:18110,openBrowser:false,trustedHosts:[]});
  c.inject(['tools'],async inner=>{const{defineTool}=await import(new URL('node_modules/@deepseek-ai/dsh-tools/lib/index.js',runtime));
   const specs=[{name:'exec',description:'Execute one named operation in the isolated workflow simulator. This is NOT a system shell. It never contacts QQ, Feishu, or article services. Only exact registered command identifiers are supported; values represent synthetic workflow state.',parameters:{command:{type:'string',required:true}},execute:async args=>{
     if(!simulator.has(args.command))throw Error('simulator-command-not-allowlisted');
     const value=structuredClone(simulator.get(args.command));
     await writeFile(resolve(project,'last-operation.json'),JSON.stringify({family,phase,command:args.command,value}));
     return value;
   }}];
   for(const spec of specs){const execute=spec.execute;spec.execute=async args=>{const start=performance.now();try{const value=await execute(args);result.toolExecutions.push({tool:spec.name,args:spec.name==='write_file'?{path:args.path,contentSha256:hash(args.content)}:args,result:value,ms:performance.now()-start});return value;}catch(e){result.toolExecutions.push({tool:spec.name,args,error:e.message,ms:performance.now()-start});throw e;}};inner.tools.register(defineTool({...spec,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}}));}
  });
  c.inject(['llm'],inner=>{const adapter=Object.create(model.adapter);adapter.resolveModel=async()=>testInfo;const stream=request=>model.llm.stream({...request,maxTokens:request.maxTokens??outputCap,signal:AbortSignal.any([...(request.signal?[request.signal]:[]),AbortSignal.timeout(600000)])});adapter.stream=stream;adapter.prepareCall=async()=>({model:testInfo,stream});adapter.listModels=async()=>[testInfo];inner.llm.registerAdapter([model.selection.provider],adapter);});
 },new URL('package.json',runtime).href);
 await sleep(2000);
 const workspace=await ctx.get('workspaceRegistry').resolveByPath(project)??await ctx.get('workspaceRegistry').create(project);
 for(const which of ['qq','workflow']) {
   family=which;const fixture=complexFixtures().find(f=>f.name===which+'-complete');
   const id='native-protocol-'+mode+suffix+'-'+which;await ctx.get('sessionController').create({sessionId:id,workspaceId:workspace.id});agent=(await ctx.get('sessionController').resolveAgent(id)).agent;session=agent.session;
   const plan=structuredClone(fixture.plan);plan.sessionId=id;simulator=new Map();
   plan.steps=plan.steps.map((s,i)=>{const reqs=(s.completion.all??[s.completion]).map((r,j)=>{
     const command=`${which}:s${i+1}:check${j+1}`;
     simulator.set(command,{ok:true,...(r.expect?{[r.expect.field]:r.expect.equals}:{}),environment:'isolated-synthetic-simulator'});
     return {tool:'exec',args:{command},...(r.expect?{expect:r.expect}:{})};
   });return {...s,completion:reqs.length===1?reqs[0]:{all:reqs},acceptance:{scope:['assertion','assertion','assertion','deployment','delivery','assertion'][i],revision:1,afterSeq:-1,dependsOn:i?[{stepId:plan.steps[i-1].id,revision:1}]:[]}};});
   const host=globalThis.__dsh_plan_completion_host__;await host.store.put(plan,{cas:null});host.states.set(id,{plan,suggestion:null,stale:false});
   const commands=indices=>indices.flatMap(i=>(plan.steps[i].completion.all??[plan.steps[i].completion]).map(r=>r.args.command));
   const execute=indices=>'依次调用 exec，每个 command 严格等于以下标识，每项一次：'+commands(indices).join('、')+'。只操作这些模拟器命令，简短报告实际回执，不能推断其他步骤完成，不做真实发送或重试。';
   phase='partial';await runPhase(which+'-partial','这是独立合成的复杂工作流模拟器，没有真实聊天或账号。保留六个既有步骤及验收条件。'+execute([0,1,2]),0,['done','done','done','todo','todo','todo']);
   const delivery=commands([4])[0],mobile=commands([5])[0],deliveryResult=simulator.get(delivery),mobileResult=simulator.get(mobile);
   simulator.set(delivery,{ok:true,accepted:true,delivery:'unknown'});simulator.set(mobile,{ok:true});
   phase='unconfirmed';await runPhase(which+'-unconfirmed',execute([3,4,5]),0,['done','done','done','done','doing','blocked']);
   const fail=commands([2])[1],success=simulator.get(fail);simulator.set(fail,{ok:false,error:'SYNTHETIC_UPSTREAM_FAILURE'});
   phase='failed';await runPhase(which+'-failed','现在仅调用 exec command="'+fail+'" 一次，记录故障后停止，不自动重试，不更改其他步骤。',0,['done','done','blocked','blocked','blocked','blocked']);
   simulator.set(fail,success);simulator.set(delivery,deliveryResult);simulator.set(mobile,mobileResult);
   phase='recovered';await runPhase(which+'-recovered','模拟器已恢复；下面只是只读检查，不重发任何东西。'+execute([2,3,4,5]),0,['done','done','done','done','done','done']);
   phase='rewrite';await runPhase(which+'-upstream-rewrite','执行受控的上游重写演练。'+execute([1]),0,['done','done','doing','blocked','blocked','blocked']);
   phase='reverify';await runPhase(which+'-downstream-reverify','上游已经变化，请重新完成所有下游检查。'+execute([2,3,4,5]),0,['done','done','done','done','done','done']);
   const newReqs=(plan.steps[1].completion.all??[plan.steps[1].completion]).map(r=>{const command=r.args.command+':v2';simulator.set(command,structuredClone(simulator.get(r.args.command)));return {...r,args:{command}};});
   const newCompletion=newReqs.length===1?newReqs[0]:{all:newReqs};
   phase='revise-acceptance';await runPhase(which+'-revise-acceptance','本轮不调用任何工具。更新计划 s2 的验收定义：保持 scope=assertion，dependsOn=[{stepId:"s1",revision:1}]，将 completion 改为 '+JSON.stringify(newCompletion)+'。这是独立的验收修订提案，旧版为1，宿主应生成新版2；不能把旧回执用于新版。请计划助手通过 progress.version=1 的 acceptance_proposed 事件提交，其他步骤定义保持不变。',0,['done','todo','blocked','blocked','blocked','blocked'],[1,2,1,1,1,1]);
   plan.steps[1].completion=newCompletion;
   phase='rebind-dependencies';await runPhase(which+'-rebind-dependencies','本轮仍不调用工具。s2 的验收版本已改为2。请通过 acceptance_proposed 分别更新 s3、s4、s5、s6，每步当前验收版本均为1，仅将它们对应前置步骤的 revision 更新为2；保持各步 scope、completion 和依赖 stepId 不变。按 s3→s4→s5→s6 顺序提交，宿主会把四步版本各递增为2。所有旧回执均不得用于新版完成。',0,['done','todo','blocked','blocked','blocked','blocked'],[1,2,2,2,2,2]);
   phase='new-revision-execution';await runPhase(which+'-new-revision-execution','现在按新版验收执行所有后续步骤。'+execute([1,2,3,4,5]),0,['done','done','done','done','done','done'],[1,2,2,2,2,2]);
   const events=[...session.snapshotEvents()];await writeFile(path('./native-'+mode+suffix+'-'+which+'-events.json'),JSON.stringify({header:session.header,events,inheritedEventCount:session.inheritedEventCount}));
 }
 result.protectedAfter=Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,hash(await readFile(resolve(project,p)))])));result.protectedUnchanged=JSON.stringify(before)===JSON.stringify(result.protectedAfter);
 result.finished=true;
}catch(e){result.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{clearInterval(samples);if(agent?.status==='running')agent.cancel({kind:'user'});await save();await ctx?.fiber.dispose();model.close();}

