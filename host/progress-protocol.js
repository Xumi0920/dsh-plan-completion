import { createHash } from 'node:crypto';
import { normalizeCompletion, completionRequirements, matchesCall, unscopedAcknowledgement } from './acceptance.js';
import { normalizeAcceptanceProposal, normalizeAcceptance, normalizeProgressEnvelope } from './progress-schema.js';
export { PROGRESS_PROTOCOL_VERSION, normalizeAcceptanceProposal, normalizeAcceptance, normalizeProof, normalizeProgressEnvelope } from './progress-schema.js';

const object = x => x && typeof x === 'object' && !Array.isArray(x);
const canonical = x => JSON.stringify(x, (_, v) => object(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
const hash = x => createHash('sha256').update(canonical(x)).digest('hex').slice(0,32);
const comparableStep = s => s ? { ...s, proof: s.proof ?? null, evidence: s.evidence ?? [] } : s;

export function scopeSatisfied(scope, completion) {
  const reqs=completionRequirements(completion),last=reqs.at(-1)?.expect;
  if(scope==='manual')return false;
  if(!reqs.length)return false;
  if(scope==='execution')return true; // operation only; never a business-delivery attestation
  if(scope==='submission')return Boolean(last&&((['accepted','submitted'].includes(last.field)&&last.equals===true)||(['status','state'].includes(last.field)&&['accepted','submitted'].includes(last.equals))));
  if(scope==='delivery')return last?.field==='delivered'&&last.equals===true;
  if(scope==='deployment')return reqs.some(r=>r.expect?.field==='installed'&&r.expect.equals===true)&&['installed','ready'].includes(last?.field)&&last.equals===true;
  return scope==='assertion'&&Boolean(last&&!['accepted','submitted','ok','success','isError','status','state'].includes(last.field));
}

function graphValid(steps) {
  const byId=new Map(steps.map(s=>[s.id,s])),visiting=new Set(),done=new Set();
  function visit(s){if(visiting.has(s.id))return false;if(done.has(s.id))return true;visiting.add(s.id);
    for(const d of s.acceptance?.dependsOn??[]){const parent=byId.get(d.stepId);if(!parent?.acceptance||d.revision!==parent.acceptance.revision||!visit(parent))return false;}
    visiting.delete(s.id);done.add(s.id);return true;}
  return steps.every(visit);
}
function canRevise(old,proposal,completion) {
  if((old.acceptance.scope!=='manual'&&old.acceptance.scope!==proposal.scope) || old.acceptance.dependsOn.some(d=>!proposal.dependsOn.some(p=>p.stepId===d.stepId)))return false;
  const before=completionRequirements(old.completion),after=completionRequirements(completion);let index=-1;
  return before.every(r=>{const i=after.findIndex((n,k)=>k>index&&n.tool===r.tool&&Object.keys(r.args).every(key=>Object.hasOwn(n.args,key))
    &&(!r.expect||!scopeSatisfied(old.acceptance.scope,old.completion)||(n.expect?.field===r.expect.field&&(typeof r.expect.equals!=='boolean'||n.expect.equals===r.expect.equals))));index=i;return i>=0;});
}

/** Derive from the current session's original journal, never from saved proof,
 * semantic scores, model claims or supplied event statuses. DAG traversal makes
 * upstream re-execution invalidate descendants even when versions are unchanged. */
export function deriveProtocol(plan, inputRecords) {
  if(!plan)return [];
  const records=inputRecords.filter(r=>r.sessionId===plan.sessionId),steps=plan.steps??[],byId=new Map(steps.map(s=>[s.id,s])),cache=new Map(),visiting=new Set();
  function evaluate(step) {
    if(cache.has(step.id))return cache.get(step.id);
    const a=normalizeAcceptance(step.acceptance);
    if(!a)return {...step,proof:null};
    if(step.source==='user') {
      if(a.scope==='manual' && step.confirmation?.revision===a.revision && step.confirmation.actor==='user' && step.status==='done') {
        const proof={revision:a.revision,firstSeq:step.confirmation.seq,lastSeq:step.confirmation.seq,fingerprint:hash({kind:'human-confirmation',acceptance:a,confirmation:step.confirmation})};
        return {...step,status:'done',lifecycle:'user_confirmed',proof};
      }
      return {...step,proof:null};
    }
    const finish=(status,lifecycle,evidence=[],proof=null)=>{const out={...step,acceptance:a,status,lifecycle,evidence,proof};cache.set(step.id,out);return out;};
    if(visiting.has(step.id))return finish('blocked','dependency_cycle');
    visiting.add(step.id);
    try {
      if(a.scope==='manual')return finish('todo','awaiting_manual_acceptance');
      if(!scopeSatisfied(a.scope,step.completion))return finish('blocked','acceptance_scope_mismatch');
      const checks=completionRequirements(step.completion).map(req=>{
        const call=records.findLast(r=>r.kind==='tool_call'&&matchesCall(r,req));
        const receipt=call&&records.findLast(r=>r.kind==='tool_result'&&r.callSeq===call.seq&&r.turn===call.turn&&r.seq>call.seq);
        const hasFact=req.expect&&Object.hasOwn(receipt?.facts??{},req.expect.field);
        const mismatch=Boolean(hasFact&&receipt.facts[req.expect.field]!==req.expect.equals);
        const ok=Boolean(call&&!call.interrupted&&receipt?.completionEligible&&!unscopedAcknowledgement(receipt,req)&&(!req.expect||(hasFact&&!mismatch)));
        return {call,receipt,mismatch,ok};
      });
      const started=checks.some(c=>c.call),parentProofs=[];
      for(const dep of a.dependsOn) {
        const parent=byId.get(dep.stepId);
        if(!parent?.acceptance||parent.acceptance.revision!==dep.revision)return finish(started?'blocked':'todo','dependency_revision_mismatch');
        const p=evaluate(parent);
        if(p.status!=='done'||!p.proof)return finish(started?'blocked':'todo','dependency_unverified');
        parentProofs.push(p.proof);
      }
      if(checks.some(c=>c.call?.interrupted||c.receipt?.outcome==='failure'||c.mismatch))return finish('blocked','latest_receipt_failed',checks.filter(c=>c.receipt).map(c=>c.receipt.id));
      if(!started)return finish('todo','awaiting_execution');
      const floor=Math.max(a.afterSeq,...parentProofs.map(p=>p.lastSeq));
      if(checks.some(c=>c.call&&c.call.seq<=floor))return finish('doing',parentProofs.some(p=>p.lastSeq>=checks[0].call?.seq)?'dependency_stale':'acceptance_revision_pending');
      if(checks.some(c=>!c.call||!c.receipt||!c.ok))return finish('doing','awaiting_receipt');
      if(checks.some((c,i)=>i&&c.call.seq<=checks[i-1].receipt.seq))return finish('doing','verification_stale');
      const evidence=checks.map(c=>c.receipt.id),proof={revision:a.revision,firstSeq:checks[0].call.seq,lastSeq:checks.at(-1).receipt.seq,
        fingerprint:hash({acceptance:a,completion:normalizeCompletion(step.completion),evidence,parents:parentProofs.map(p=>p.fingerprint)})};
      return finish('done','verified_receipt',evidence,proof);
    } finally {visiting.delete(step.id);}
  }
  for(const step of steps)if(step.acceptance)evaluate(step);
  return steps.filter(s=>s.acceptance&&s.source!=='user').map(s=>cache.get(s.id)??s);
}

export function progressSnapshot(plan,records) {
  return {version:1,steps:deriveProtocol(plan,records).map(s=>({step_id:s.id,acceptance_revision:s.acceptance.revision,scope:s.acceptance.scope,
    state:s.status,lifecycle:s.lifecycle,evidence_ids:s.evidence??[],proof:s.proof??null,depends_on:s.acceptance.dependsOn}))};
}

/** Model proposals may create/revise acceptance in a separate update. Host owns
 * revision/fence/proof. Events with a stale revision, foreign IDs or weak scope
 * are rejected; independent committed receipts still reconcile on every call. */
export function applyProgressProtocol(output,plan,records) {
  const result=structuredClone(output),baseSteps=plan?.steps??[],before=new Map(baseSteps.map(s=>[s.id,s]));
  const scoped=plan?records.filter(r=>r.sessionId===plan.sessionId):records,afterSeq=Math.max(-1,...scoped.map(r=>r.seq));
  let steps=structuredClone(result.op==='rewrite'?result.steps:baseSteps),rejected=0;
  // Protected versioned definitions survive model rewrites, renamed titles,
  // deletion, dropped status and direct completion/proof replacement.
  if(result.op==='rewrite') {
    steps=steps.map(s=>before.get(s.id)?.acceptance?structuredClone(before.get(s.id)):s);
    for(const old of baseSteps)if(old.acceptance&&!steps.some(s=>s.id===old.id))steps.push(structuredClone(old));
    if(steps.length>7){steps=structuredClone(baseSteps);result.op='none';rejected++;}
    for(const s of steps)if(!before.get(s.id)?.acceptance&&s.acceptance){
      const proposal=normalizeAcceptanceProposal(s.acceptance);
      if(proposal){s.acceptance={...proposal,revision:1,afterSeq};s.status='todo';s.evidence=[];s.proof=null;}
      else {delete s.acceptance;s.status='todo';rejected++;}
    }
    if(!graphValid(steps)){steps=structuredClone(baseSteps);result.op='none';rejected++;}
  }
  const envelope=result.progress===undefined?{version:1,events:[]}:normalizeProgressEnvelope(result.progress);
  if(!envelope)rejected++;
  for(const event of envelope?.events??[]) {
    const step=steps.find(s=>s.id===event.step_id),a=step?.acceptance;
    if(!step||step.source==='user'||(a?.revision??0)!==event.acceptance_revision){rejected++;continue;}
    if(event.event==='acceptance_proposed'||event.event==='dependencies_proposed') {
      // Dependency-only proposals copy the existing scope and full contract.
      // The model need not repeat (or gain authority to modify) those fields.
      const proposal=event.event==='dependencies_proposed'?{scope:a.scope,dependsOn:event.depends_on}:event.acceptance;
      const completion=event.event==='dependencies_proposed'?step.completion:event.completion;
      if(a&&(!canRevise(step,proposal,completion)||a.revision>=1000000000)){rejected++;continue;}
      if(proposal.scope!=='manual'&&!scopeSatisfied(proposal.scope,completion)){rejected++;continue;}
      if(a&&canonical({scope:a.scope,dependsOn:a.dependsOn,completion:step.completion})===canonical({...proposal,completion}))continue;
      const revised={...step,completion,acceptance:{...proposal,revision:(a?.revision??0)+1,afterSeq},proof:null,evidence:[],status:'todo'};
      const candidate=steps.map(s=>s.id===step.id?revised:s);
      // A revision may leave descendants pinned to the old version (they are
      // intentionally invalidated); new references must match current parents.
      if(revised.acceptance.dependsOn.some(d=>d.stepId===step.id||!candidate.some(s=>s.id===d.stepId&&s.acceptance?.revision===d.revision))){rejected++;continue;}
      const cycleCheck=candidate.map(s=>({...s,acceptance:s.acceptance?{...s.acceptance,dependsOn:s.acceptance.dependsOn.map(d=>({...d,revision:candidate.find(p=>p.id===d.stepId)?.acceptance?.revision??d.revision}))}:undefined}));
      if(!graphValid(cycleCheck)){rejected++;continue;}steps=candidate;
    } else {
      const expectedKind=event.event==='step_started'?'tool_call':'tool_result';
      const valid=event.evidence_ids.every(id=>{const r=scoped.find(x=>x.id===id);if(!r||r.kind!==expectedKind)return false;
        const call=r.kind==='tool_call'?r:scoped.find(c=>c.kind==='tool_call'&&c.seq===r.callSeq&&c.turn===r.turn);
        return call&&call.seq>a.afterSeq&&completionRequirements(step.completion).some(req=>matchesCall(call,req))&&(event.event!=='step_blocked'||r.outcome==='failure');});
      if(!valid)rejected++;
    }
  }
  const derived=deriveProtocol({...plan,sessionId:plan?.sessionId??scoped[0]?.sessionId,steps},scoped),byId=new Map(derived.map(s=>[s.id,s]));
  for(const proposed of result.op==='patch'?result.changes:result.op==='rewrite'?result.steps:[]) {
    const actual=byId.get(proposed.id);
    if(actual && ['status','title','completion'].some(k=>Object.hasOwn(proposed,k)&&canonical(proposed[k])!==canonical(actual[k])))rejected++;
  }
  if(result.op==='rewrite')result.steps=steps.map(s=>byId.get(s.id)??s);
  else {
    const changes=(result.op==='patch'?result.changes:[]).filter(c=>!steps.find(s=>s.id===c.id)?.acceptance);
    for(const s of derived)if(canonical(comparableStep(s))!==canonical(comparableStep(before.get(s.id))))changes.push(s);
    if(changes.length){result.op='patch';result.changes=changes;}
    else {result.op='none';result.changes=[];}
  }
  delete result.progress;
  if(rejected){result.suggestion='验收提案有未生效项，请核对版本和条件';result.alternates=[];}
  else if(derived.some(s=>['dependency_revision_mismatch','dependency_stale','dependency_unverified','dependency_cycle','acceptance_scope_mismatch'].includes(s.lifecycle))){
    result.suggestion='先核对失效验收和依赖，再验证受影响步骤';result.alternates=[];
  }
  return {output:result,rejected};
}
