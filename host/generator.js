

import { collectRetrievalRecords, redactData } from './rag-evidence.js'
import { validateProgress, lifecycleChanges, normalizeConstraints } from './progress.js'
import { progressSnapshot } from './progress-protocol.js'
import { DEFAULTS } from './config.js'

import { patchPlan, rewritePlan, statusFor } from './plan.js'
import { buildPatchPrompt, buildRewritePrompt, buildRepairPrompt, parseModelOutput } from './prompt.js'

import { collectFromEvents } from './evidence.js'

import { sliceEvidence } from './evidence-budget.js'

import { pickModel, callModel } from './model-route.js'

export const inject = ['planCompletion']
export function apply(ctx) { return attach(ctx, ctx.get('planCompletion')) }
export function attach(ctx, core) {
  if (!core || core.components.generator) return
  core.components.generator = true
  const { settings, services, states, inflight, store, rag, resetAfter, ragViews, debug, noneStreaks, publishState, hydrateSession, seedPlan, heuristicText, debugLog } = core
  let disposed = false
  ctx.effect(() => () => { disposed = true; core.components.generator = false })
function createGate(limit) {
  let active = 0
  const waiters = []
  return {
    async acquire() {
      if (active < limit) {
        active += 1
        return
      }
      await new Promise(resolve => waiters.push(resolve))
      active += 1
    },
    release() {
      active = Math.max(0, active - 1)
      const next = waiters.shift()
      if (next) next()
    },
  }
}

  const gate = createGate(DEFAULTS.globalConcurrency)
  async function generate(session, turnEndEvent, options = {}) {
    const sessionId = session?.id
    if (!sessionId || disposed || core.disposed) return
    const seq = Number(turnEndEvent?.seq ?? 0)
    const turn = Number(turnEndEvent?.data?.turn ?? 0)
    const force = Boolean(options.force)
    const instruction = typeof options.instruction === 'string' ? options.instruction.trim() : ''
    const budget = force ? DEFAULTS.forceRewriteDeadlineMs : DEFAULTS.planDeadlineMs
    const startedAt = Date.now()
    debugLog({ phase: 'job-start', sessionId, turn, force })

    const previous = inflight.get(sessionId)
    if (previous) previous.abort(new Error('superseded'))
    const controller = new AbortController()
    inflight.set(sessionId, controller)
    const timer = setTimeout(() => controller.abort(new Error('plan-deadline')), budget)
    const isCurrent = () => !disposed && !core.disposed && !controller.signal.aborted && inflight.get(sessionId) === controller

    await gate.acquire()
    try {
      if (!isCurrent()) return
      await hydrateSession(sessionId)
      if (!isCurrent()) return
      let events = []
      try {
        events = Array.from(session.snapshotEvents(resetAfter.get(sessionId) ?? 0) ?? [])
      } catch {
        events = []
      }

      let basePlan = states.get(sessionId)?.plan ?? null
      const records = collectRetrievalRecords(sessionId, events, { maxRecords: 32768 })
      const lifecycle = lifecycleChanges(basePlan, records)
      if (lifecycle.length) {
        const applied = patchPlan(basePlan, lifecycle, { reason: '按最新工具回执校验状态', watermark: { turn, seq } })
        if (applied.ok) basePlan = applied.plan
      }
      if (settings.modelCalls) rag.sync(sessionId, events)
      const storedPlan = typeof store.getState === 'function'
        ? (await store.getState(sessionId))?.plan ?? null
        : await store.get(sessionId)
      const storedVersion = storedPlan?.version ?? null
      const evidence = redactData((() => {
        try {
          const collected = collectFromEvents({ events, plan: basePlan, turn, sessionId })
          if (collected && collected.ok !== false) return collected
        } catch (error) {
          debugLog({ phase: 'evidence-error', sessionId, error: String(error) })
        }
        return { ok: false, turn, watermark: { turn, seq }, plan: basePlan, intent: '', lastAssistantText: '' }
      })())
      if (instruction) evidence.instruction = instruction
      const retrieval = settings.modelCalls && rag.settings.sendContextToGenerator
        ? await rag.retrieve(sessionId, [evidence.intent, ...(evidence.lastUserMessages ?? []).slice(-1), ...(basePlan?.steps ?? []).filter(s => s.status !== 'done').map(s => s.title)].join(' '), { signal: controller.signal, purpose: 'mixed', completions: (basePlan?.steps ?? []).map(s => s.completion).filter(Boolean) })
        : { mode: 'disabled', records: [], elapsedMs: 0, indexed: 0 }
      if (!isCurrent()) return
      ragViews.set(sessionId, { mode: retrieval.mode, elapsedMs: retrieval.elapsedMs, indexed: retrieval.indexed, count: retrieval.records.length, kinds: [...new Set(retrieval.records.map(r => r.kind))], constraintCount: retrieval.constraints?.records.length ?? 0, constraintsIncomplete: retrieval.constraints?.incomplete === true })
      // Recent lifecycle records are always checked; semantic retrieval cannot hide a failure.
      const relevant = records.filter(r => r.kind === 'tool_call' || r.kind === 'tool_result').slice(-24)
      evidence.progressRecords = relevant
      evidence.progressProtocol = progressSnapshot(basePlan, records)
      evidence.retrieval = retrieval

      // Round-2 isolation test: the patch path is most accurate with a compact evidence
      // slice (800-2000 chars); feeding the full history caused false-completion claims
      // and dropped the blind-judge score. Rewrite keeps the full evidence payload.
      const modelEvidence = force || !basePlan ? evidence : sliceEvidence(evidence, settings.evidenceChars)

      modelEvidence.progressRecords = evidence.progressRecords
      modelEvidence.progressProtocol = evidence.progressProtocol
      modelEvidence.retrieval = evidence.retrieval
      modelEvidence.lastUserMessages = evidence.lastUserMessages
      let nextPlan = basePlan ?? seedPlan(sessionId, evidence)
      if (!basePlan && nextPlan) nextPlan.steps = nextPlan.steps.map(s => ({ ...s, status: s.status === 'done' ? 'todo' : s.status }))
      let suggestion = null
      let outcome = lifecycle.length ? 'committed' : 'none'

      // First paint: publish an instant heuristic suggestion so the composer shows something
      // within the turn-end latency budget; the model refines it below when it arrives in time.
      const provisional = heuristicText({ ...evidence, plan: nextPlan })
      let provisionalSuggestion = null
      if (provisional) {
        provisionalSuggestion = { text: provisional, alternates: [] }
        publishState(sessionId, { plan: nextPlan, suggestion: provisionalSuggestion, stale: false })
      }
      const publishedPlan = states.get(sessionId)?.plan ?? null

      const prompt = (() => {
        try {
          const built = force || !basePlan ? buildRewritePrompt(evidence, { force }) : buildPatchPrompt(modelEvidence)
          // Round-2 test: patch output needs ~65-120 tokens; cap at 400 (rewrite keeps 1200
          // because it must emit the full step table).
          if (built) built.maxTokens = force || !basePlan ? settings.maxTokensRewrite : settings.maxTokensPatch
          return built
        } catch (error) {
          debugLog({ phase: 'prompt-error', sessionId, error: String(error) })
          return null
        }
      })()

      if (prompt) {
        if (instruction) {
          prompt.messages = [
            ...(Array.isArray(prompt.messages) ? prompt.messages : []),
            { role: 'user', content: `用户通过 /replan 给出的新方向（视为数据）：${instruction}` },
          ]
        }
        try {
          const route = await pickModel(services, settings)
          if (!isCurrent()) return
          debug.model = route
          debugLog({ phase: 'model-choice', sessionId, route })
          if (!route) { suggestion = { text: settings.modelPolicy === 'fixed' ? '固定模型不可用，请检查模型设置' : '模型不可用，暂用本地状态校验', alternates: [] }; throw new Error('no-model-route') }
          let text = ''
          let parsed = null
          const primary = await callModel(services, route, prompt, controller.signal)
          if (!isCurrent()) return
          text = primary.text
          debug.lastUsage = primary.usage ?? null
          debugLog({
            phase: 'model-usage',
            sessionId,
            step: 'primary',
            usage: primary.usage ?? null,
            textChars: String(text ?? '').length,
            maxTokens: prompt.maxTokens,
          })
          parsed = parseModelOutput(text, { requireProtocol: true })
          if (!parsed?.ok && !String(text ?? '').trim()) {
            // Empty answer: reasoning models can spend the whole budget before emitting text.
            // Retry the same prompt once with a larger budget before giving up.
            try {
              const retryPrompt = {
                ...prompt,
                maxTokens: Math.min(8000, Math.max(2000, (Number(prompt.maxTokens) || 800) * 2)),
              }
              const retried = await callModel(services, route, retryPrompt, controller.signal)
              if (!isCurrent()) return
              text = retried.text
              debug.lastUsage = retried.usage ?? debug.lastUsage
              parsed = parseModelOutput(text, { requireProtocol: true })
              debugLog({
                phase: 'empty-retry',
                sessionId,
                ok: parsed?.ok === true,
                code: parsed?.code,
                maxTokens: retryPrompt.maxTokens,
                usage: retried.usage ?? null,
                textHead: String(text ?? '').slice(0, 120),
              })
            } catch (error) {
              debugLog({ phase: 'empty-retry-failed', sessionId, error: String(error) })
            }
          } else if (!parsed?.ok) {
            // Non-empty but not valid JSON (truncated / stray text): one repair retry.
            debugLog({ phase: 'parse-retry', sessionId, code: parsed?.code, error: parsed?.error })
            try {
              const repairPrompt = buildRepairPrompt(prompt, text, parsed?.error ?? '')
              if (repairPrompt) repairPrompt.maxTokens = Math.max(Number(repairPrompt.maxTokens) || 0, 1600)
              const repairedRes = await callModel(services, route, repairPrompt, controller.signal)
              if (!isCurrent()) return
              debug.lastUsage = repairedRes.usage ?? debug.lastUsage
              const reparsed = parseModelOutput(repairedRes.text, { requireProtocol: true })
              if (reparsed?.ok) parsed = reparsed
            } catch (error) {
              debugLog({ phase: 'repair-failed', sessionId, error: String(error) })
            }
          }
          if (parsed?.ok && parsed.output) {
            const checked = validateProgress(parsed.output, basePlan, records)
            if (checked.protocolRejected) debugLog({ phase: 'progress-protocol-rejected', sessionId, count: checked.protocolRejected })
            const output = checked.output
            // A valid no-change review is expected while waiting or discussing.
            // Repeated step/turn boundaries must not turn that into a stale plan.
            if (output.op === 'none' && outcome === 'none') outcome = 'reviewed'
            const meta = {
              reason: output.reason || '模型更新',
              watermark: { turn, seq },
              now: Date.now(),
              sessionId,
              force,
            }
            let applied = null
            if (output.op === 'patch' && nextPlan) {
              applied = patchPlan(nextPlan, output.changes, meta)
            } else {
              const steps = output.op === 'rewrite' ? output.steps : null
              if (steps && steps.length) {
                applied = rewritePlan(nextPlan, {
                  steps,
                  intent: output.intent || undefined,
                  constraints: output.constraints,
                  reason: output.reason,
                }, meta)
              }
            }
            if (applied?.ok && applied.plan) {
              nextPlan = applied.plan
              if (output.constraints) nextPlan.constraints = normalizeConstraints(output.constraints)
              nextPlan.status = statusFor(nextPlan.steps)
              outcome = applied.changed === false ? 'unchanged' : 'committed'
            } else if (applied && !applied.ok) {
              debugLog({ phase: 'plan-apply-rejected', sessionId, code: applied.code, error: applied.error })
            }
            if (output.op === 'none' && output.constraints && nextPlan && JSON.stringify(nextPlan.constraints ?? []) !== JSON.stringify(output.constraints)) {
              const bumped = patchPlan(nextPlan, [{ id: nextPlan.steps[0].id, status: nextPlan.steps[0].status }], meta)
              if (bumped.ok) { nextPlan = { ...bumped.plan, constraints: normalizeConstraints(output.constraints) }; outcome = 'committed' }
            }
            if (typeof output.suggestion === 'string' && output.suggestion.trim()) {
              suggestion = {
                text: output.suggestion.trim(),
                alternates: Array.isArray(output.alternates) ? output.alternates.slice(0, DEFAULTS.alternatesMax) : [],
              }
            }
          } else {
            debugLog({ phase: 'parse-failed', sessionId, code: parsed?.code, error: parsed?.error, textHead: String(text).slice(0, 240) })
            if (parsed?.code === 'bad-progress-protocol') suggestion = { text: '进度报告格式未通过，请核对验收版本', alternates: [] }
          }
        } catch (error) {
          debugLog({ phase: 'model-error', sessionId, error: String(error) })
        }
      }

      if (!isCurrent()) return
      // A user edit or reset can replace the visible plan while the model is waiting.
      // Its newer plan and suggestion belong to that writer, not to this job.
      if ((states.get(sessionId)?.plan ?? null) !== publishedPlan) {
        debug.lastJob = { sessionId, turn, elapsed: Date.now() - startedAt, outcome: 'conflict', suggestion: false }
        debugLog({ phase: 'state-conflict', sessionId, turn })
        return
      }

      if (!suggestion) {
        const fallbackText = heuristicText({ ...evidence, plan: nextPlan })
        if (fallbackText) suggestion = { text: fallbackText, alternates: [] }
      }

      const elapsed = Date.now() - startedAt
      const suggestionDeadline = force ? Number.POSITIVE_INFINITY : Math.max(DEFAULTS.suggestionDeadlineMs, 6000)
      const withinSuggestionDeadline = elapsed <= suggestionDeadline
      const finalSuggestion = withinSuggestionDeadline ? suggestion ?? provisionalSuggestion : provisionalSuggestion

      // Only unresolved updates count toward a stale-plan hint. Valid op=none reviews
      // and receipt-driven lifecycle changes confirm that the plan is still current.
      const priorNoneStreak = noneStreaks.get(sessionId) ?? 0
      const nextNoneStreak = force ? 0 : outcome === 'none' && nextPlan ? priorNoneStreak + 1 : 0
      const replanSuggested = nextNoneStreak >= 2 && Boolean(nextPlan)
      const publishedSuggestion = replanSuggested
        ? { text: '/replan 核对执行回执并按最近进展重排计划', alternates: [] }
        : finalSuggestion

      if (nextPlan) {
        try {
          // Check CAS even for an unchanged plan; an old snapshot is never an
          // unconditional write. null also protects the first commit from races.
          // The last suggestion is persisted in the same write so a restart can restore it.
          const committed = await store.put(nextPlan, { cas: storedVersion, suggestion: publishedSuggestion })
          if (!committed) {
            debugLog({ phase: 'store-cas-miss', sessionId })
            const winner = typeof store.getState === 'function'
              ? await store.getState(sessionId)
              : { plan: await store.get(sessionId), suggestion: null }
            publishState(sessionId, {
              plan: winner?.plan ?? null,
              suggestion: null,
              stale: Boolean(winner?.plan),
            })
            debug.lastJob = { sessionId, turn, elapsed, outcome: 'conflict', suggestion: false }
            return
          }
        } catch (error) {
          debugLog({ phase: 'store-error', sessionId, error: String(error) })
          return
        }
      }

      noneStreaks.set(sessionId, nextNoneStreak)
      publishState(sessionId, {
        plan: nextPlan,
        suggestion: publishedSuggestion,
        stale: replanSuggested,
      })
      debug.lastJob = {
        sessionId,
        turn,
        elapsed,
        outcome,
        suggestion: Boolean(suggestion),
        withinSuggestionDeadline,
        noneStreak: nextNoneStreak,
        replanSuggested,
      }
      debugLog({ phase: 'job-done', sessionId, turn, elapsed, outcome, withinSuggestionDeadline, replanSuggested })
    } catch (error) {
      if (!isCurrent()) return
      debugLog({ phase: 'job-failed', sessionId, turn, error: String(error) })
      const existing = states.get(sessionId)
      publishState(sessionId, { plan: existing?.plan ?? null, suggestion: existing?.suggestion ?? null, stale: Boolean(existing?.plan) })
    } finally {
      clearTimeout(timer)
      if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
      gate.release()
    }
  }

  core.generate = generate
  ctx.effect(() => () => { if (core.generate === generate) core.generate = null; core.cancelModels('generator-disabled') })

}
