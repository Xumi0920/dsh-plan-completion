import { normalizeCompletion } from './acceptance.js';
import { redactSecrets } from './rag-evidence.js';

export const PROGRESS_PROTOCOL_VERSION = 1;
const scopes = ['execution','submission','delivery','deployment','assertion','manual'];
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const safeId = x => typeof x === 'string' && /^[\p{L}\p{N}_.:-]{1,64}$/u.test(x) && !['__proto__','constructor','prototype'].includes(x) && redactSecrets(x) === x;
const revision = x => Number.isSafeInteger(x) && x >= 1 && x <= 1000000000;
const keys = (x, allowed) => Object.keys(x).every(k=>allowed.includes(k));

export function normalizeAcceptanceProposal(value) {
  if (!object(value) || !scopes.includes(value.scope) || !Array.isArray(value.dependsOn) || value.dependsOn.length > 6) return undefined;
  const dependsOn=[];
  for (const d of value.dependsOn) {
    if (!object(d) || !keys(d,['stepId','revision']) || !safeId(d.stepId) || !revision(d.revision) || dependsOn.some(p=>p.stepId===d.stepId)) return undefined;
    dependsOn.push({ stepId:d.stepId, revision:d.revision });
  }
  return { scope:value.scope, dependsOn };
}
export function normalizeAcceptance(value) {
  const proposal=normalizeAcceptanceProposal(value);
  if (!proposal || !revision(value.revision) || !Number.isSafeInteger(value.afterSeq) || value.afterSeq < -1) return undefined;
  return { ...proposal, revision:value.revision, afterSeq:value.afterSeq };
}
export function normalizeProof(value) {
  if (!object(value) || !revision(value.revision) || !/^[a-f0-9]{32}$/.test(value.fingerprint)
    || !Number.isSafeInteger(value.firstSeq) || !Number.isSafeInteger(value.lastSeq) || value.firstSeq < 0 || value.lastSeq <= value.firstSeq) return undefined;
  return { revision:value.revision, fingerprint:value.fingerprint, firstSeq:value.firstSeq, lastSeq:value.lastSeq };
}

/** Only the plan helper's separately parsed envelope is accepted. Assistant
 * prose, reasoning, compaction text and tool payloads never enter this parser. */
export function normalizeProgressEnvelope(value) {
  if (!object(value) || !keys(value,['version','events']) || value.version!==1 || !Array.isArray(value.events) || value.events.length>7) return undefined;
  const events=[],seen=new Set();
  for (const e of value.events) {
    if (!object(e) || !safeId(e.step_id) || seen.has(e.step_id) || !Number.isSafeInteger(e.acceptance_revision) || e.acceptance_revision<0 || e.acceptance_revision>1000000000
      || !['evidence_added','step_started','step_blocked','acceptance_proposed','dependencies_proposed'].includes(e.event)) return undefined;
    const item={step_id:e.step_id,acceptance_revision:e.acceptance_revision,event:e.event};
    if(e.event==='acceptance_proposed') {
      if(!keys(e,['step_id','acceptance_revision','event','acceptance','completion']) || !object(e.acceptance) || !keys(e.acceptance,['scope','dependsOn']))return undefined;
      item.acceptance=normalizeAcceptanceProposal(e.acceptance);item.completion=normalizeCompletion(e.completion);
      if(!item.acceptance || (!item.completion&&item.acceptance.scope!=='manual'))return undefined;
    } else if(e.event==='dependencies_proposed') {
      if(!keys(e,['step_id','acceptance_revision','event','depends_on']) || !revision(e.acceptance_revision))return undefined;
      const proposal=normalizeAcceptanceProposal({scope:'manual',dependsOn:e.depends_on});
      if(!proposal)return undefined;item.depends_on=proposal.dependsOn;
    } else {
      if(!keys(e,['step_id','acceptance_revision','event','evidence_ids']) || !revision(e.acceptance_revision) || !Array.isArray(e.evidence_ids) || !e.evidence_ids.length || e.evidence_ids.length>6
        || e.evidence_ids.some(id=>typeof id!=='string'||!/^rag:[a-f0-9]{24}$/.test(id)) || new Set(e.evidence_ids).size!==e.evidence_ids.length)return undefined;
      item.evidence_ids=[...e.evidence_ids];
    }
    seen.add(e.step_id);events.push(item);
  }
  return {version:1,events};
}
