import { completionRequirements, matchesCall } from './progress.js';

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
