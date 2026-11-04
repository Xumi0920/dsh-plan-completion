import { normalizePlan, statusFor } from './plan.js'

/** Explicit human attestation, separate from tool proof. Never called by the model. */
export function confirmStep(plan, request, { now = Date.now(), seq = plan?.watermark?.seq ?? 0 } = {}) {
  seq = Number.isSafeInteger(seq) ? Math.max(0, seq) : 0
  const step = plan?.steps?.find(s => s.id === request.stepId)
  if (!step) return { ok: false, error: 'step-not-found' }
  if (plan.version.gen !== request.version?.gen || plan.version.rev !== request.version?.rev || step.acceptance?.revision !== request.acceptanceRevision) return { ok: false, error: 'version-conflict' }
  if (step.acceptance?.scope !== 'manual' || typeof request.confirmed !== 'boolean') return { ok: false, error: 'manual-scope-required' }
  if (request.confirmed === Boolean(step.confirmation)) return { ok: true, plan, unchanged: true }
  const target = { ...step, status: request.confirmed ? 'done' : 'todo', source: request.confirmed ? 'user' : 'model', evidence: [], proof: null }
  if (request.confirmed) {
    target.confirmation = { revision: step.acceptance.revision, at: now, seq, actor: 'user' }
    target.lifecycle = 'user_confirmed'
  } else {
    delete target.confirmation
    target.acceptance = { ...step.acceptance, revision: step.acceptance.revision + 1, afterSeq: seq }
    target.lifecycle = 'awaiting_manual_acceptance'
  }
  const steps = plan.steps.map(s => s.id === step.id ? target : s)
  return normalizePlan({ ...plan, steps, status: statusFor(steps), version: { gen: plan.version.gen + 1, rev: 0 }, updatedAt: now,
    editedByUser: true, reason: request.confirmed ? '用户确认人工验收' : '用户撤回人工验收' })
}
