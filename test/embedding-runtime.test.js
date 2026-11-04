import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createManagedEmbeddingClient, embeddingBackend, runtimeEnvironment } from '../host/embedding-runtime.js'
function fixture(extra = {}) {
  const workers=[],calls=[]; let time=0
  const dependencies={now:()=>time,validateFiles:async()=>({executablePath:'/synthetic/llama-server',modelPath:'/synthetic/model.gguf'}),freePort:async()=>19001,probe:async()=>true,
    createClient:()=>({embed:async texts=>texts.map(()=>new Float32Array(1024)),close(){}}),
    spawn(command,args,options){calls.push({command,args,options});const worker=new EventEmitter();worker.exitCode=null;worker.send=(message,cb)=>{if(message.type==='start'){worker.start=message;worker.emit('message',{type:'spawned',pid:1000+workers.length})}else setImmediate(()=>{worker.exitCode=0;worker.emit('exit',0)});cb?.()};worker.disconnect=()=>{worker.exitCode=0;worker.emit('exit',0)};workers.push(worker);return worker},...extra}
  return {workers,calls,dependencies,advance(){time+=10000}}
}
test('managed backend is lazy, shares startup and never uses a shell or provider environment',async()=>{
  const f=fixture(),c=createManagedEmbeddingClient({},f.dependencies);assert.equal(f.calls.length,0)
  await Promise.all([c.embed(['中文']),c.embed(['English'])]);assert.equal(f.calls.length,1);assert.equal(c.snapshot().state,'ready')
  assert.equal(f.calls[0].options.shell,false);assert.equal(f.calls[0].options.windowsHide,true)
  assert.deepEqual(runtimeEnvironment({PATH:'bin',DSH_TOKEN:'private',OPENAI_API_KEY:'private',HTTPS_PROXY:'private',LLAMA_ARG_HOST:'0.0.0.0'}),{PATH:'bin'})
  assert.equal(runtimeEnvironment({}, {electron:'synthetic'}).ELECTRON_RUN_AS_NODE,'1')
  assert.equal(JSON.stringify(c.snapshot()).includes(f.workers[0].start.key),false)
  await c.close();assert.equal(c.snapshot().state,'closed');assert.equal(c.snapshot().pid,null)
})
test('unexpected owned-child exit falls back and permits a bounded later restart',async()=>{
  const f=fixture(),c=createManagedEmbeddingClient({},f.dependencies);await c.embed(['a']);f.workers[0].exitCode=1;f.workers[0].emit('exit',1)
  assert.equal(c.snapshot().state,'failed');await assert.rejects(c.embed(['b']),/cooling-down/);assert.equal(f.calls.length,1)
  f.advance();await c.embed(['b']);assert.equal(f.calls.length,2);await c.close()
})
test('close during file validation cannot spawn a late model process',async()=>{
  let release;const f=fixture({validateFiles:()=>new Promise(r=>{release=r})}),c=createManagedEmbeddingClient({},f.dependencies)
  const pending=c.embed(['a']);await c.close();release({});await assert.rejects(pending);assert.equal(f.calls.length,0);assert.equal(c.snapshot().state,'closed')
})
test('missing official model fails before spawning and explicit endpoint configs retain compatibility',async()=>{
  const f=fixture({validateFiles:async()=>{throw Error('not-official-q8')}}),c=createManagedEmbeddingClient({},f.dependencies)
  await assert.rejects(c.embed(['a']));assert.equal(f.calls.length,0);assert.equal(c.snapshot().error,'not-official-q8');await c.close()
  assert.equal(embeddingBackend({}),'llama.cpp');assert.equal(embeddingBackend({endpoint:'http://127.0.0.1:11434/v1/embeddings'}),'external');assert.equal(embeddingBackend({backend:'llama.cpp',endpoint:'old'}),'llama.cpp')
})
test('startup deadline stops the owned supervisor rather than adopting an unrelated listener',async()=>{
  const f=fixture({probe:async()=>false}),c=createManagedEmbeddingClient({startupTimeoutMs:1000},f.dependencies)
  await assert.rejects(c.embed(['a']));assert.equal(f.workers[0].exitCode,0);assert.equal(c.snapshot().pid,null);await c.close()
})

test('query abort does not wait for a shared cold startup or cancel another caller',async()=>{
  let release;const f=fixture({validateFiles:()=>new Promise(r=>{release=r})}),c=createManagedEmbeddingClient({},f.dependencies)
  const controller=new AbortController(),first=c.embed(['cancelled query'],controller.signal),second=c.embed(['index batch'])
  controller.abort();await assert.rejects(first,/cancelled/);assert.equal(f.calls.length,0)
  release({});assert.equal((await second).length,1);assert.equal(f.calls.length,1);await c.close()
})
