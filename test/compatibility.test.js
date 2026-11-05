import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { createHostFixture, sessionFixture, initialOutput, patchOutput, flushJobs } from '../support/host-fixture.js'
import { validateProgress } from '../host/progress.js'
import { collectRetrievalRecords } from '../host/rag-evidence.js'
import { deriveProtocol } from '../host/progress-protocol.js'
import { confirmStep } from '../host/confirmation.js'
function legacy(value) { const copy = structuredClone(value); delete copy.progress; for (const s of copy.steps ?? []) delete s.acceptance; return copy }
function setup(t, responses, config = {}) { const h = createHostFixture(apply, responses, { persistPlans: false, ...config }); t.after(() => h.dispose()); return h }
async function turn(h,s,n) { h.startTurn(s,n); await flushJobs(); return h.state(s.id).plan }

test('legacy opt-out retains 0.1.8 patch version, doing state, rewrite and two-none replan hint', async t => {
  const none = { op: 'none', reason: 'unchanged', suggestion: 'continue' }
  const h = setup(t, [legacy(initialOutput()), legacy(patchOutput('s2','doing')), none, none, legacy(initialOutput())], { progressProtocol: 'legacy' }), s = sessionFixture('legacy-ux')
  const first = await turn(h,s,1); assert.equal(first.steps[0].status,'done')
  const second = await turn(h,s,2); assert.deepEqual(second.version,{gen:1,rev:1}); assert.equal(second.steps[1].status,'doing')
  await turn(h,s,3); await turn(h,s,4); assert.equal(h.state(s.id).stale,true); assert.match(h.state(s.id).suggestion.text,/^\/replan/)
  assert.equal(h.core.publicView(s.id).assurance,'legacy-unverified')
  await h.request('/plan-completion/replan',{sessionId:s.id}); await flushJobs()
  assert.equal(h.state(s.id).plan.version.gen,2); assert.equal(h.state(s.id).plan.steps[0].status,'done')
})

test('strict rewrite keeps established valid receipts; fresh definitions cannot retro-certify', () => {
  const sessionId='rewrite-proof', plan={sessionId,steps:[{id:'s1',title:'执行检查',status:'done',completion:{tool:'exec',args:{command:'check'}},acceptance:{scope:'execution',revision:1,afterSeq:-1,dependsOn:[]}}]}
  const records=collectRetrievalRecords(sessionId,[{seq:0,type:'tool/call',data:{turn:1,callId:'c',name:'exec',arguments:{command:'check'}}},{seq:1,type:'tool/result',data:{turn:1,message:{toolCallId:'c',content:[{type:'text',text:'{"ok":true}'}]}}}])
  const output={op:'rewrite',progress:{version:1,events:[]},steps:structuredClone(plan.steps)}
  assert.equal(validateProgress(output,plan,records).output.steps[0].status,'done')
  assert.notEqual(validateProgress(output,null,records).output.steps[0].status,'done')
  assert.equal(validateProgress(output,null,records).output.steps[0].proof,null)
})

test('explicit strict migration resets unverified legacy claims and cannot be downgraded later', async t => {
  const h=setup(t,[legacy(initialOutput()),{op:'patch',progress:{version:1,events:[]},reason:'claim',changes:[{id:'s1',status:'done'}]}],{progressProtocol:'legacy'}),s=sessionFixture('migration-policy')
  await turn(h,s,1); assert.equal(h.state(s.id).plan.steps[0].status,'done')
  await h.request('/plan-completion/settings',{progressProtocol:'strict'})
  assert.ok(h.state(s.id).plan.steps.every(x=>x.acceptance&&x.status==='todo'))
  await h.request('/plan-completion/settings',{progressProtocol:'legacy'})
  await turn(h,s,2);assert.equal(h.state(s.id).plan.steps[0].status,'todo');assert.equal(h.core.publicView(s.id).assurance,'validated')
})

test('manual confirmation is an authenticated production action with CAS, durable actor and revocation', async t => {
  const h=setup(t,[initialOutput()]),s=sessionFixture('human-confirm');await turn(h,s,1)
  const request={sessionId:s.id,stepId:'s1',version:h.state(s.id).plan.version,acceptanceRevision:1,confirmed:true}
  h.services.connection.requestRejection=()=>401;assert.equal((await h.request('/plan-completion/confirm',request)).status,401)
  h.services.connection.requestRejection=()=>undefined
  const result=await h.request('/plan-completion/confirm',request);assert.equal(result.status,200)
  let plan=h.state(s.id).plan;assert.equal(plan.steps[0].status,'done');assert.equal(plan.steps[0].lifecycle,'user_confirmed');assert.equal(plan.steps[0].confirmation.actor,'user')
  assert.equal((await h.request('/plan-completion/confirm',request)).status,409)
  assert.equal((await h.core.store.get(s.id)).steps[0].confirmation.actor,'user')
  await h.request('/plan-completion/confirm',{...request,version:plan.version,confirmed:false})
  plan=h.state(s.id).plan;assert.equal(plan.steps[0].status,'todo');assert.equal(plan.steps[0].acceptance.revision,2);assert.equal(plan.steps[0].confirmation,undefined)
})

test('manual endpoint cannot certify machine execution and human prerequisites invalidate on revocation', async t => {
  const h=setup(t,[initialOutput()]),s=sessionFixture('human-boundary');await turn(h,s,1)
  const plan=h.state(s.id).plan;plan.steps[1].acceptance.scope='execution';plan.steps[1].acceptance.dependsOn=[{stepId:'s1',revision:1}];plan.steps[1].completion={tool:'exec',args:{command:'check'}}
  const request={sessionId:s.id,stepId:'s2',version:plan.version,acceptanceRevision:1,confirmed:true}
  assert.equal((await h.request('/plan-completion/confirm',request)).status,400)
  await h.request('/plan-completion/confirm',{...request,stepId:'s1'})
  const confirmed=h.state(s.id).plan
  const records=collectRetrievalRecords(s.id,[{seq:11,type:'tool/call',data:{turn:2,callId:'c',name:'exec',arguments:{command:'check'}}},{seq:12,type:'tool/result',data:{turn:2,message:{toolCallId:'c',content:[{type:'text',text:'{"ok":true}'}]}}}])
  assert.equal(deriveProtocol(confirmed,records).find(x=>x.id==='s2').status,'done')
  await h.request('/plan-completion/confirm',{...request,stepId:'s1',version:confirmed.version,confirmed:false})
  assert.notEqual(deriveProtocol(h.state(s.id).plan,records).find(x=>x.id==='s2').status,'done')
})

test('RAG settings reject unknown keys and invalid paths; managed mode needs no paths', async t => {
  const h=setup(t,[]);const before=structuredClone(h.core.rawConfig.rag)
  for(const rag of [{shell:'pwsh'},{modelPath:'relative.gguf'},{executablePath:'x\nmalicious'},{autoManage:false,enabled:true,backend:'llama.cpp'}])assert.equal((await h.request('/plan-completion/settings',{rag})).status,400)
  assert.deepEqual(h.core.rawConfig.rag,before)
  // Zero-config default: enabling managed llama.cpp does not require paths and
  // stays lazy (no download until prepare/embed).
  const enabled=await h.request('/plan-completion/settings',{rag:{enabled:true,backend:'llama.cpp',autoManage:true}})
  assert.equal(enabled.status,200)
  const disabled=await h.request('/plan-completion/settings',{rag:{enabled:false}})
  assert.equal(disabled.status,200)
})

test('model cannot forge a human confirmation or overwrite an established user decision', () => {
  const forged={id:'s1',title:'人工验收',status:'done',source:'user',confirmation:{actor:'user',revision:1,at:new Date().toISOString(),seq:3},acceptance:{scope:'manual',revision:1,afterSeq:-1,dependsOn:[]}}
  const proposed=validateProgress({op:'rewrite',steps:[forged]},null,[]).output.steps[0]
  assert.equal(proposed.status,'todo');assert.notEqual(proposed.source,'user')
  const kept=validateProgress({op:'rewrite',steps:[{...forged,status:'todo',confirmation:null}]},{sessionId:'human',steps:[forged]},[]).output.steps[0]
  assert.equal(kept.status,'done');assert.deepEqual(kept.confirmation,forged.confirmation)
})

test('human confirmation remains durable before the first journal event', () => {
  const plan={sessionId:'empty-journal',version:{gen:1,rev:0},watermark:{seq:0,turn:0},steps:[1,2,3].map(n=>({id:'s'+n,title:'人工验收 '+n,status:'todo',source:'model',acceptance:{scope:'manual',revision:1,afterSeq:-1,dependsOn:[]}}))}
  const result=confirmStep(plan,{stepId:'s1',version:plan.version,acceptanceRevision:1,confirmed:true},{seq:-1})
  assert.equal(result.ok,true);assert.equal(result.plan.steps[0].confirmation.seq,0);assert.equal(result.plan.steps[0].confirmation.actor,'user')
})
