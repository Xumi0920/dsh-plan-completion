import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createManagedEmbeddingClient } from '../host/embedding-runtime.js'
const options={enabled:true,executablePath:process.env.DSH_LLAMA_SERVER,modelPath:process.env.DSH_Q8_MODEL,retryDelayMs:100,idleTimeoutMs:1000}
assert.ok(options.executablePath && options.modelPath,'Set DSH_LLAMA_SERVER and DSH_Q8_MODEL to absolute paths')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
async function until(test){for(let i=0;i<100;i++){if(await test())return;await sleep(100)}throw Error('timeout')}
if(process.argv.includes('--host-crash')){
 const client=createManagedEmbeddingClient({...options,idleTimeoutMs:60000});await client.embed(['synthetic orphan cleanup']);process.send(client.snapshot());setInterval(()=>{},1000)
}else{
 const out={date:new Date().toISOString(),engine:'user supplied llama.cpp',model:'official Qwen3-Embedding-0.6B Q8_0',checks:[],warmMs:[]},record=(name,detail)=>{out.checks.push({name,pass:true,detail});console.log('PASS '+name)}
 let proxyRequests=0;const proxy=createServer((_q,r)=>{proxyRequests++;r.end('blocked')});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));process.env.HTTPS_PROXY=process.env.HTTP_PROXY=`http://127.0.0.1:${proxy.address().port}`
 const client=createManagedEmbeddingClient(options)
 try{
  let start=performance.now();const v=await client.embed(['请检索 QQAgent 登录失败的原因','I intend to run tests, but there is no execution receipt yet.','async function retrieve(query) { return index.search(query) }']);out.coldMs=performance.now()-start
  assert.deepEqual(v.map(x=>x.length),[1024,1024,1024]);assert.ok(v.every(x=>Math.abs(Math.hypot(...x)-1)<1e-4));record('real official Q8 vectors', {coldMs:out.coldMs,dimensions:1024})
  const ready=client.snapshot(),pid=ready.pid
  const r=await fetch(`http://127.0.0.1:${ready.port}/v1/embeddings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:['unauthorized']})});assert.equal(r.status,401);record('unauthenticated embedding denied',r.status)
  for(let i=0;i<8;i++){start=performance.now();await client.embed(['中文会话：计划尚未验收，请查找约束。','English reasoning: intention is not completion evidence.']);out.warmMs.push(performance.now()-start)}
  if(process.platform==='win32')out.memory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${pid} | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}))
  try{out.gpu=execFileSync('nvidia-smi',['--query-gpu=name,memory.used,memory.total,utilization.gpu','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true}).trim()}catch{}
  process.kill(pid);await until(()=>client.snapshot().state==='failed');await sleep(150);await client.embed(['recover after owned server termination']);assert.equal(client.snapshot().starts,2);record('server crash restart', {starts:2})
  const idlePid=client.snapshot().pid;await until(()=>client.snapshot().state==='stopped');assert.equal(alive(idlePid),false);record('idle release stops owned server',true)
  await client.embed(['restart after idle']);assert.equal(client.snapshot().starts,3);const last=client.snapshot().pid;await client.close();assert.equal(alive(last),false);record('explicit close and lazy reload',true)
  const host=spawn(process.execPath,[fileURLToPath(import.meta.url),'--host-crash'],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});const owned=await new Promise((resolve,reject)=>{host.once('message',resolve);host.once('error',reject)});host.kill();await until(()=>!alive(owned.pid));record('Host crash IPC disconnect reaps server',true)
  assert.equal(proxyRequests,0);record('no HTTP proxy traffic',proxyRequests)
 }finally{await client.close();proxy.close()}
 await writeFile(process.env.DSH_VALIDATION_OUTPUT ?? 'managed-runtime-result.json',JSON.stringify(out,null,2));console.log(JSON.stringify({pass:out.checks.length,coldMs:out.coldMs,warmMs:out.warmMs,memory:out.memory,gpu:out.gpu}))
}
