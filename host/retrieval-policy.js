import { completionRequirements, matchesCall, unscopedAcknowledgement } from './progress.js';

export function retrievalPurpose(query, purpose) {
  if (['intent','evidence','constraints','mixed'].includes(purpose)) return purpose;
  if (/思考|打算|准备|reasoning|intend/i.test(query)) return 'intent';
  if (/约束|限制|constraint/i.test(query)) return 'constraints';
  if (/回执|执行结果|退出码|是否.*(?:完成|通过)|证据|receipt|evidence|exit.?code/i.test(query)) return 'evidence';
  return 'mixed';
}
export function queryInstruction(query, purpose = 'mixed') {
  const task = {
    intent: 'Retrieve the original reasoning intent relevant to the question. Intent is not execution evidence.',
    evidence: 'Retrieve the latest actual tool execution receipts for the exact requested file or command, including failures.',
    constraints: 'Retrieve original human constraints and subsequent human amendments, not generated summaries.',
    mixed: 'Retrieve relevant conversation context and actual execution evidence for updating the current plan.',
  }[purpose];
  return `Instruct: ${task}\nQuery: ${query}`;
}
export function eligibleForPurpose(record, purpose) {
  if (purpose === 'intent') return record.kind === 'reasoning_intent';
  if (purpose === 'evidence') return record.kind === 'tool_result' || record.kind === 'tool_call';
  if (purpose === 'constraints') return record.kind === 'user_message';
  return true;
}
/** Mandatory receipt lookup uses the established targets, independently of
 * similarity. These are context records only; progress.js still verifies them. */
export function targetRecords(records, completions) {
  const selected = new Map();
  for (const completion of completions.slice(0, 7)) for (const requirement of completionRequirements(completion)) {
    const call = records.findLast(r => r.kind === 'tool_call' && matchesCall(r, requirement));
    if (!call) continue;
    const receipt = records.findLast(r => r.kind === 'tool_result' && r.callSeq === call.seq && r.turn === call.turn && r.seq > call.seq);
    if (receipt) selected.set(receipt.id, receipt);
    selected.set(call.id, call);
  }
  return [...selected.values()];
}

/** Bounded pointers for EVERY established criterion, independently of semantic
 * top-K. No receipt bodies, user text, or raw facts are copied here. This is a
 * lookup over the current session's retained records, not a completion verdict;
 * progress.js still checks identity, ordering, eligibility and all citations. */
export function targetCoverage(records, completions, { maxChars = 12000 } = {}) {
  const budget = Number.isFinite(maxChars) ? Math.max(80, Math.min(12000, Math.floor(maxChars))) : 12000;
  const groups = [], source = Array.isArray(completions) ? completions : [];
  let omitted = Math.max(0, source.length - 7);
  for (const [completionIndex, completion] of source.slice(0, 7).entries()) {
    const requirements = completionRequirements(completion);
    if (!requirements.length) continue;
    const checks = requirements.map((requirement, criterionIndex) => {
      const call = records.findLast(r => r.kind === 'tool_call' && matchesCall(r, requirement));
      const receipt = call && records.findLast(r => r.kind === 'tool_result' && r.callSeq === call.seq && r.turn === call.turn && r.seq > call.seq);
      const check = { criterionIndex, callSeq: call?.seq ?? null, interrupted: call?.interrupted === true,
        receiptId: receipt?.id ?? null, receiptSeq: receipt?.seq ?? null,
        outcome: receipt?.outcome ?? 'unknown', completionEligible: receipt?.completionEligible === true };
      if (requirement.expect) check.expectation = !Object.hasOwn(receipt?.facts ?? {}, requirement.expect.field)
        ? 'unknown' : receipt.facts[requirement.expect.field] === requirement.expect.equals ? 'matched' : 'mismatch';
      if (unscopedAcknowledgement(receipt, requirement)) check.acceptanceUnspecified = true;
      return check;
    });
    const receiptReady = checks.every((c, i) => c.callSeq !== null && !c.interrupted && c.receiptId !== null
      && c.outcome === 'success' && c.completionEligible && !c.acceptanceUnspecified && (!c.expectation || c.expectation === 'matched')
      && (!i || c.callSeq > checks[i - 1].receiptSeq));
    const group = { completionIndex, receiptReady, checks };
    // Keep a whole criterion group or mark the omission explicitly. Never
    // silently truncate an ID or make a partial checklist look complete.
    if (JSON.stringify({ groups: [...groups, group], incomplete: true, omitted: 999 }).length <= budget) groups.push(group);
    else omitted++;
  }
  return { groups, incomplete: omitted > 0, omitted };
}
