/**
 * Host half of dsh-plan-completion.
 *
 * Responsibilities (design doc v1.2 §3.5):
 * - watch committed Session events for `turn/end` and run one plan job per session;
 * - call the model through the injected `llm` service (never through the agent loop);
 * - keep the implicit plan and the next-message suggestion per session in memory;
 * - expose the state to the Client half over a local HTTP route registered on `webServer`;
 * - register the `/roadmap` and `/replan` human commands.
 *
 * The Client half only talks to this half through `/plan-completion/*`
 * (verified contract: same-origin fetch from the Electron page works and the body is readable).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { DEFAULTS } from './host/config.js'
import { requestRejection, safeDebugRecord, safeDiagnostics } from './host/security.js'
import { join } from 'node:path'
import { normalizePlan, patchPlan, rewritePlan, statusFor, applyUserEdit } from './host/plan.js'
import { buildPatchPrompt, buildRewritePrompt, buildRepairPrompt, parseModelOutput, buildVerifyPrompt, parseVerifyOutput } from './host/prompt.js'
import { heuristicSuggestion, fallbackPlan } from './host/heuristics.js'
import { collectFromEvents } from './host/evidence.js'
import { createMemoryStore, createFileStore } from './host/store.js'
import { runExperiment } from './host/experiment.js'
import { sliceEvidence } from './host/experiment.js'

const ROUTE_PREFIX = '/plan-completion/'

// Debug log location is configurable (`config.debugDir` or DSH_PLAN_COMPLETION_DEBUG_DIR).
// Empty means "do not write files", so a published copy of this bundle carries no local paths.
let debugDir = ''
function debugLogPath() {
  return debugDir ? join(debugDir, 'plan-completion-runtime.jsonl') : ''
}

function debugLog(record) {
  try {
    if (!debugDir) return
    mkdirSync(debugDir, { recursive: true })
    appendFileSync(debugLogPath(), `${JSON.stringify({ time: new Date().toISOString(), ...safeDebugRecord(record) })}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the local plan-store directory. `~` is expanded so a shipped config can point at the
 * user's home without hard-coding an absolute path. Empty means "memory only".
 */
function expandStorageDir(value, envValue) {
  const raw = typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : (typeof envValue === 'string' ? envValue.trim() : '')
  if (raw === '') return ''
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    try {
      return raw === '~' ? homedir() : join(homedir(), raw.slice(2))
    } catch {
      return ''
    }
  }
  return raw
}

function readJsonBody(req) {
  return new Promise(resolve => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > 512 * 1024) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function jsonResponse(res, status, value) {
  let body = ''
  try {
    body = JSON.stringify(value)
  } catch {
    body = '{"ok":false}'
  }
  try {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }
    if (typeof res.writeHead === 'function') {
      res.writeHead(status, headers)
      res.end(body)
    } else {
      res.end(body)
    }
  } catch {
    /* ignore */
  }
}

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

/** Convert one request message to the block form the `llm` service accepts. */
function toRequestMessage(message) {
  if (!message || typeof message !== 'object') return null
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null
  if (!role) return null
  const content = message.content
  if (Array.isArray(content)) return { role, content }
  if (typeof content === 'string') {
    return role === 'assistant'
      ? { role, content: [{ type: 'text', text: content }] }
      : { role, content: [{ type: 'text', text: content }] }
  }
  return null
}

function normalizePromptMessages(prompt) {
  const messages = Array.isArray(prompt?.messages) ? prompt.messages : []
  return messages.map(toRequestMessage).filter(Boolean)
}

/**
 * Use the user's current default route only. Never send session evidence to
 * another configured provider/model just because it may respond faster.
 */
async function pickModel(services) {
  const llm = services.llm
  const selection = services.agentDefaultModel?.currentSelection?.()
  if (!llm || !selection?.provider || !selection?.model) return null
  const route = { provider: selection.provider, model: selection.model, source: 'session-default' }
  try {
    const info = await llm.resolveModelInfo?.(route.provider, route.model)
    const efforts = info?.reasoning?.efforts
    if (Array.isArray(efforts) && efforts.length) route.reasoningEffort = efforts[0]?.id
  } catch {
    // Resolution failure must not silently choose a different data destination.
  }
  return route
}

/** Experiments also stay on the explicitly selected route (not an independent judge). */
async function pickJudgeRoute(_services, mainRoute) {
  return mainRoute
}

async function callModel(services, route, prompt, signal) {
  if (!services.llm || !route) throw new Error('no-llm-route')
  const messages = normalizePromptMessages(prompt)
  if (!messages.length) throw new Error('empty-messages')
  let text = ''
  let usage = null
  const request = {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages,
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
    signal,
  }
  if (route.reasoningEffort) request.reasoningEffort = route.reasoningEffort
  const stream = services.llm.stream(request)
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage
    else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        throw new Error(`model-${kind}:${chunk.reason?.failure?.message ?? ''}`)
      }
    }
  }
  return { text, usage }
}

const HOST_GLOBAL_KEY = '__dsh_plan_completion_host__'

/**
 * Process-wide host state. DSH may re-apply this plugin (toggle, hot reload) while the old
 * module instance is still alive: keeping state and route disposers in `globalThis` makes the
 * new instance reuse the same maps and dispose the previous route handlers, so we never end
 * up with two live handler sets answering different state.
 */
function hostGlobal() {
  const fallback = { states: new Map(), sessions: new Map(), handledTurns: new Map(), warmAttempts: new Map(), noneStreaks: new Map(), disposers: [] }
  if (typeof globalThis === 'undefined') return { ...fallback, store: createMemoryStore() }
  if (!globalThis[HOST_GLOBAL_KEY] || typeof globalThis[HOST_GLOBAL_KEY] !== 'object') {
    globalThis[HOST_GLOBAL_KEY] = fallback
  }
  const shared = globalThis[HOST_GLOBAL_KEY]
  if (!(shared.states instanceof Map)) shared.states = new Map()
  if (!(shared.sessions instanceof Map)) shared.sessions = new Map()
  if (!(shared.handledTurns instanceof Map)) shared.handledTurns = new Map()
  if (!(shared.warmAttempts instanceof Map)) shared.warmAttempts = new Map()
  if (!(shared.noneStreaks instanceof Map)) shared.noneStreaks = new Map()
  if (!Array.isArray(shared.disposers)) shared.disposers = []
  if (!shared.store || typeof shared.store.get !== 'function' || typeof shared.store.put !== 'function') {
    shared.store = createMemoryStore()
    // Adopt plans retained by older plugin versions during an in-process upgrade.
    for (const state of shared.states.values()) {
      if (state?.plan) shared.store.put(state.plan, { cas: null })
    }
  }
  return shared
}

export function apply(ctx, config = {}) {
  // Production settings, frozen by the round-1/round-2 isolation tests:
  //   evidenceChars      1500  — compact evidence slice for the patch path
  //   maxTokensPatch      400  — patch output only needs ~65-120 tokens
  //   maxTokensRewrite   1200  — rewrite must emit the full step table
  const readInt = (value, fallback, min, max) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.min(max, Math.max(min, number))
  }
  const rawConfig = config && typeof config === 'object' ? config : {}
  const settings = {
    evidenceChars: readInt(rawConfig.evidenceChars, 1500, 400, 8000),
    maxTokensPatch: readInt(rawConfig.maxTokensPatch, 400, 120, 4000),
    maxTokensRewrite: readInt(rawConfig.maxTokensRewrite, 1200, 400, 8000),
    warmBackfill: rawConfig.warmBackfill !== false,
    modelCalls: rawConfig.modelCalls !== false,
    persistPlans: rawConfig.persistPlans !== false,
    storageDir: expandStorageDir(rawConfig.storageDir, process.env.DSH_PLAN_COMPLETION_STORE_DIR),
    maxTokensVerify: readInt(rawConfig.maxTokensVerify, DEFAULTS.maxTokensVerify, 200, 2000),
    enableDebugRoutes: rawConfig.enableDebugRoutes === true,
    debugDir: typeof rawConfig.debugDir === 'string' && rawConfig.debugDir.trim() !== ''
      ? rawConfig.debugDir.trim()
      : (typeof process !== 'undefined' && process.env && typeof process.env.DSH_PLAN_COMPLETION_DEBUG_DIR === 'string'
        ? process.env.DSH_PLAN_COMPLETION_DEBUG_DIR.trim()
        : ''),
  }
  debugDir = settings.debugDir

  // Services may come up after this plugin on a cold boot, so resolve them lazily on every
  // access instead of snapshotting them during apply(). Registration that needs a service is
  // wrapped in ctx.inject([...]) below, which re-runs once the service becomes available.
  const services = {
    get llm() {
      return settings.modelCalls ? ctx.get('llm') : null
    },
    get webServer() {
      return ctx.get('webServer')
    },
    get connection() {
      return ctx.get('connection')
    },
    get commands() {
      return ctx.get('commands')
    },
    get agentDefaultModel() {
      return ctx.get('agentDefaultModel')
    },
    get agents() {
      return ctx.get('agents')
    },
    get sessionPersistence() {
      return ctx.get('sessionPersistence')
    },
  }

  const shared = hostGlobal()
  // A new apply can run before the old context has finished disposing.
  shared.stopGeneration?.()
  const states = shared.states // sessionId -> { plan, suggestion, stale }
  const sessions = shared.sessions // sessionId -> Session
  const warmAttempts = shared.warmAttempts // sessionId -> { at, seq }
  const inflight = new Map() // sessionId -> AbortController
  const verifyInflight = new Set() // sessionId -> 正在核对（同一会话同时只允许一个）
  const gate = createGate(DEFAULTS.globalConcurrency)
  // Persistence: a file-backed plan store when a directory is configured; otherwise memory.
  // The store keeps the last plan + suggestion per session so a restart can restore the UI.
  const fileStore = settings.persistPlans && settings.storageDir ? createFileStore(settings.storageDir) : null
  const store = fileStore ?? createMemoryStore()
  shared.store = store
  let disposed = false
  const stopGeneration = () => {
    disposed = true
    for (const controller of inflight.values()) controller.abort(new Error('plugin-disposed'))
    inflight.clear()
    if (shared.stopGeneration === stopGeneration) delete shared.stopGeneration
  }
  shared.stopGeneration = stopGeneration
  ctx.effect(() => stopGeneration)
  const debug = { lastTurnEnd: null, lastJob: null, model: null }
  let debugTheme = null
  const experimentState = { running: false, result: null, error: null }

  const publicView = sessionId => {
    const state = states.get(sessionId)
    const plan = state?.plan ?? null
    return {
      sessionId,
      plan,
      version: plan?.version ?? null,
      status: plan?.status ?? null,
      intent: plan?.intent ?? null,
      steps: Array.isArray(plan?.steps) ? plan.steps : [],
      updatedAt: plan?.updatedAt ?? state?.updatedAt ?? null,
      reason: plan?.reason ?? null,
      suggestion: state?.suggestion ?? null,
      stale: state ? Boolean(state.stale) : true,
      debugTheme,
    }
  }

  function publishState(sessionId, patch) {
    const previous = states.get(sessionId) ?? { plan: null, suggestion: null, stale: false }
    states.set(sessionId, { ...previous, ...patch })
  }

  // ── Persistence ⇄ in-memory state ────────────────────────────────────────
  const hydration = new Map() // sessionId -> Promise (in-flight disk reads)

  // Adopt plans retained in memory across a hot reload into the file store. `cas:null` means
  // "only when the file has no plan yet", so a newer on-disk plan is never overwritten.
  if (fileStore) {
    for (const [sessionId, state] of states.entries()) {
      if (!state?.plan) continue
      void fileStore
        .put(state.plan, { cas: null, suggestion: state.suggestion ?? null })
        .catch(() => {})
    }
  }

  /**
   * Load a persisted plan (+ last suggestion) into the shared in-memory state. The UI can show
   * the previous plan right after a DSH restart, before the next turn runs.
   */
  async function hydrateSession(sessionId) {
    if (!sessionId) return
    if (states.get(sessionId)?.plan) return
    const pending = hydration.get(sessionId)
    if (pending) return pending
    const task = (async () => {
      try {
        const stored = typeof store.getState === 'function'
          ? await store.getState(sessionId)
          : { plan: await store.get(sessionId), suggestion: null }
        if (!stored?.plan || states.get(sessionId)?.plan) return
        const normalized = normalizePlan(stored.plan)
        if (!normalized?.ok || !normalized.plan) return
        states.set(sessionId, {
          plan: normalized.plan,
          suggestion: stored.suggestion && typeof stored.suggestion === 'object' ? stored.suggestion : null,
          stale: false,
        })
        debugLog({ phase: 'state-hydrated', sessionId })
      } catch (error) {
        debugLog({ phase: 'state-hydrate-error', sessionId, error: String(error) })
      } finally {
        hydration.delete(sessionId)
      }
    })()
    hydration.set(sessionId, task)
    return task
  }

  function seedPlan(sessionId, evidence) {
    const intent = evidence?.intent || evidence?.firstUserMessage || '推进当前会话目标'
    const fallback = (() => {
      try {
        return fallbackPlan(intent)
      } catch {
        return null
      }
    })()
    const steps = fallback?.ok && Array.isArray(fallback.steps) ? fallback.steps : [
      { id: 's1', title: '确认目标与约束', status: 'done', source: 'model' },
      { id: 's2', title: '完成核心改动', status: 'doing', source: 'model' },
      { id: 's3', title: '验证并收尾', status: 'todo', source: 'model' },
    ]
    const candidate = {
      sessionId,
      version: { gen: 0, rev: 0 },
      status: 'active',
      intent: fallback?.intent || intent,
      steps,
      updatedAt: Date.now(),
      reason: '启发式初始化计划',
      watermark: evidence?.watermark ?? { turn: 0, seq: 0 },
      editedByUser: false,
    }
    try {
      const normalized = normalizePlan(candidate)
      if (normalized?.ok && normalized.plan) return normalized.plan
    } catch {
      /* ignore */
    }
    return null
  }

  function heuristicText(evidence) {
    try {
      const result = heuristicSuggestion(evidence)
      if (result?.ok && typeof result.text === 'string' && result.text.trim()) return result.text.trim()
    } catch {
      /* ignore */
    }
    return ''
  }

  // ── Warm backfill: build an implicit plan for a session the plugin has never observed ──
  // Live sessions come from `sessions.get()`; older sessions are read through the durable
  // session store so opening them also produces a plan + suggestion.
  async function loadStoredEvents(sessionId, limit = 240) {
    const persistence = services.sessionPersistence
    if (!persistence || typeof persistence.open !== 'function') return null
    let handle = null
    try {
      handle = await persistence.open(sessionId, 'read')
      let total = 0
      let page = null
      try {
        const stat = await persistence.stat?.(sessionId)
        total = Number(stat?.eventCount ?? 0)
        page = stat
      } catch {
        total = 0
      }
      const from = Math.max(0, total - limit)
      let read = await handle.read(from, limit)
      let events = Array.isArray(read?.events) ? read.events.slice() : []
      // Fallback: some backends report no eventCount — page from the beginning until the end.
      if (!events.length && !page) {
        let offset = 0
        for (let guard = 0; guard < 40; guard += 1) {
          const chunk = await handle.read(offset, 400)
          const batch = Array.isArray(chunk?.events) ? chunk.events : []
          if (!batch.length) break
          events = events.concat(batch)
          offset += batch.length
        }
        events = events.slice(-limit)
      }
      return events
    } catch {
      return null
    } finally {
      try {
        await handle?.close?.()
      } catch {
        /* ignore */
      }
    }
  }

  function warmSessionShim(sessionId, events) {
    const last = events[events.length - 1] ?? null
    let lastTurn = 0
    let maxTurn = 0
    let hasConversation = false
    for (const event of events) {
      const type = String(event?.type ?? '')
      if (type === 'turn/end') lastTurn = Math.max(lastTurn, Number(event.data?.turn ?? 0))
      if (type === 'turn/start') maxTurn = Math.max(maxTurn, Number(event.data?.turn ?? 0))
      if (type === 'user/message' || type === 'assistant/message') hasConversation = true
    }
    return {
      warm: true,
      id: sessionId,
      seq: Number(last?.seq ?? 0),
      lastTurn: lastTurn || maxTurn,
      hasConversation,
      snapshotEvents(from) {
        const start = Number(from ?? 0)
        return events.filter(event => Number(event?.seq ?? 0) >= start)
      },
    }
  }

  async function runWarmBackfill(sessionId, options = {}) {
    if (!settings.warmBackfill) return { ok: false, reason: 'disabled' }
    if (!sessionId) return { ok: false, reason: 'no-session-id' }
    await hydrateSession(sessionId)
    if (states.get(sessionId)?.plan) return { ok: true, already: true }
    const now = Date.now()
    const attempt = warmAttempts.get(sessionId)
    if (!options.force && attempt && now - Number(attempt.at ?? 0) < 10 * 60 * 1000) {
      return { ok: true, skipped: 'recent', at: attempt.at }
    }
    warmAttempts.set(sessionId, { at: now, seq: attempt?.seq ?? 0 })

    const live = sessions.get(sessionId) ?? null
    if (live) {
      const turn = Number(debug.lastTurnEnd?.sessionId === sessionId ? debug.lastTurnEnd.turn : 0)
      void runGeneration(live, { seq: Number(live.seq ?? 0), data: { turn } }, { force: true })
      return { ok: true, started: true, source: 'live' }
    }

    const events = await loadStoredEvents(sessionId, 1500)
    if (!events || events.length === 0) {
      debugLog({ phase: 'warm-no-history', sessionId })
      return { ok: false, reason: 'no-history' }
    }
    const shim = warmSessionShim(sessionId, events)
    if (!shim.hasConversation) {
      return {
        ok: false,
        reason: 'no-conversation',
        detail: { events: events.length, types: events.slice(-8).map(event => event?.type) },
      }
    }
    warmAttempts.set(sessionId, { at: now, seq: shim.seq })
    debugLog({ phase: 'warm-start', sessionId, events: events.length, turn: shim.lastTurn })
    try {
      await runGeneration(shim, { seq: shim.seq, data: { turn: shim.lastTurn } }, { force: true })
    } catch (error) {
      debugLog({ phase: 'warm-failed', sessionId, error: String(error) })
      return { ok: false, reason: 'generation-failed', detail: String(error) }
    }
    const view = publicView(sessionId)
    debugLog({ phase: 'warm-done', sessionId, version: view.version, hasSuggestion: Boolean(view.suggestion) })
    return { ok: true, warmed: true, version: view.version, suggestion: view.suggestion, plan: view.plan }
  }

  async function runGeneration(session, turnEndEvent, options = {}) {
    const sessionId = session?.id
    if (!sessionId || disposed) return
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
    const isCurrent = () => !disposed && !controller.signal.aborted && inflight.get(sessionId) === controller

    await gate.acquire()
    try {
      if (!isCurrent()) return
      await hydrateSession(sessionId)
      if (!isCurrent()) return
      let events = []
      try {
        events = Array.from(session.snapshotEvents(Math.max(0, seq - 300)) ?? [])
      } catch {
        events = []
      }

      const basePlan = states.get(sessionId)?.plan ?? null
      const storedPlan = typeof store.getState === 'function'
        ? (await store.getState(sessionId))?.plan ?? null
        : await store.get(sessionId)
      const storedVersion = storedPlan?.version ?? null
      const evidence = (() => {
        try {
          const collected = collectFromEvents({ events, plan: basePlan, turn, sessionId })
          if (collected && collected.ok !== false) return collected
        } catch (error) {
          debugLog({ phase: 'evidence-error', sessionId, error: String(error) })
        }
        return { ok: false, turn, watermark: { turn, seq }, plan: basePlan, intent: '', lastAssistantText: '' }
      })()
      if (instruction) evidence.instruction = instruction

      // Round-2 isolation test: the patch path is most accurate with a compact evidence
      // slice (800-2000 chars); feeding the full history caused false-completion claims
      // and dropped the blind-judge score. Rewrite keeps the full evidence payload.
      const modelEvidence = force || !basePlan ? evidence : sliceEvidence(evidence, settings.evidenceChars)

      let nextPlan = basePlan ?? seedPlan(sessionId, evidence)
      let suggestion = null
      let outcome = 'none'

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
          if (built) built.maxTokens = force ? settings.maxTokensRewrite : settings.maxTokensPatch
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
          const route = await pickModel(services)
          if (!isCurrent()) return
          debug.model = route
          debugLog({ phase: 'model-choice', sessionId, route })
          if (!route) throw new Error('no-model-route')
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
          parsed = parseModelOutput(text)
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
              parsed = parseModelOutput(text)
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
              const reparsed = parseModelOutput(repairedRes.text)
              if (reparsed?.ok) parsed = reparsed
            } catch (error) {
              debugLog({ phase: 'repair-failed', sessionId, error: String(error) })
            }
          }
          if (parsed?.ok && parsed.output) {
            const output = parsed.output
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
                  reason: output.reason,
                }, meta)
              }
            }
            if (applied?.ok && applied.plan) {
              nextPlan = applied.plan
              nextPlan.status = statusFor(nextPlan.steps)
              outcome = applied.changed === false ? 'unchanged' : 'committed'
            } else if (applied && !applied.ok) {
              debugLog({ phase: 'plan-apply-rejected', sessionId, code: applied.code, error: applied.error })
            }
            if (typeof output.suggestion === 'string' && output.suggestion.trim()) {
              suggestion = {
                text: output.suggestion.trim(),
                alternates: Array.isArray(output.alternates) ? output.alternates.slice(0, DEFAULTS.alternatesMax) : [],
              }
            }
          } else {
            debugLog({ phase: 'parse-failed', sessionId, code: parsed?.code, error: parsed?.error, textHead: String(text).slice(0, 240) })
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

      // A long `op=none` streak means the visible plan stopped tracking the conversation
      // (edited-by-user plans cannot be rewritten automatically, and one coarse step may need
      // splitting). Surface an actionable replan suggestion instead of repeating a stale one.
      const priorNoneStreak = noneStreaks.get(sessionId) ?? 0
      const nextNoneStreak = force ? 0 : outcome === 'none' && nextPlan ? priorNoneStreak + 1 : 0
      const replanSuggested = nextNoneStreak >= 2 && Boolean(nextPlan)
      const publishedSuggestion = replanSuggested
        ? { text: '/replan 按最近进展重排计划，把已完成项标记完成', alternates: [] }
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

  // ── Session event subscription: one plan job per completed turn ──────────
  const handledTurns = shared.handledTurns // sessionId -> last handled turn number
  const noneStreaks = shared.noneStreaks // sessionId -> consecutive op=none outcomes

  function triggerTurnEnd(session, seq, turn, source) {
    if (!session?.id || disposed) return
    sessions.set(session.id, session)
    const turnNumber = Number(turn) || 0
    if (handledTurns.get(session.id) === turnNumber) return
    handledTurns.set(session.id, turnNumber)
    debug.lastTurnEnd = { sessionId: session.id, seq: Number(seq) || 0, turn: turnNumber, source }
    debugLog({ phase: 'turn-end-trigger', sessionId: session.id, turn: turnNumber, source })
    void runGeneration(session, { seq: Number(seq) || 0, data: { turn: turnNumber } }, { force: false })
  }

  // Deterministic idle fallback: after the session log goes quiet for a moment, read the last
  // committed `turn/end` straight from the session log. This does not depend on the turn-boundary
  // event reaching the plugin context (it may be missed across a plugin reload window).
  const idleTimers = new Map()
  const IDLE_QUIET_MS = 2000
  ctx.effect(() => () => {
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
  })

  function checkIdleTurn(session) {
    if (!session?.id || disposed) return
    let events = []
    try {
      const from = Math.max(0, Number(session.seq ?? 0) - 160)
      events = Array.from(session.snapshotEvents(from) ?? [])
    } catch {
      return
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'turn/end') continue
      if (event.data?.reason?.kind !== 'completed') return
      const eventTime = Number(event.time ?? 0)
      // Only act on a turn that just ended (plugin reloads must not replay old turns).
      if (eventTime > 0 && Date.now() - eventTime > 5 * 60 * 1000) return
      const turn = Number(event.data?.turn ?? 0)
      if (handledTurns.get(session.id) === turn) return
      debugLog({ phase: 'idle-turn-end', sessionId: session.id, turn })
      triggerTurnEnd(session, event.seq, turn, 'idle-log-scan')
      return
    }
  }

  function scheduleIdleCheck(session) {
    if (!session?.id || disposed) return
    const previous = idleTimers.get(session.id)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      idleTimers.delete(session.id)
      try {
        checkIdleTurn(sessions.get(session.id) ?? session)
      } catch (error) {
        debugLog({ phase: 'idle-check-error', sessionId: session.id, error: String(error) })
      }
    }, IDLE_QUIET_MS)
    idleTimers.set(session.id, timer)
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (disposed) return
      debug.eventCount = (debug.eventCount ?? 0) + 1
      debug.eventTypes = debug.eventTypes ?? {}
      const type = String(event?.type ?? 'unknown')
      debug.eventTypes[type] = (debug.eventTypes[type] ?? 0) + 1
      if (debug.eventCount <= 12) debugLog({ phase: 'session-event', type, sessionId: session?.id })
      if (!session?.id) return
      sessions.set(session.id, session)
      scheduleIdleCheck(session)
      if (event?.type !== 'turn/end') return
      debugLog({ phase: 'turn-end-raw', sessionId: session.id, turn: event.data?.turn, reason: event.data?.reason?.kind, seq: event.seq })
      if (event.data?.reason?.kind !== 'completed') return
      triggerTurnEnd(session, event.seq, event.data?.turn, 'session/event')
    } catch (error) {
      debugLog({ phase: 'listener-error', error: String(error) })
    }
  })

  // Fallback trigger: if a `turn/end` event is not observed through `session/event` for any reason,
  // the transition to `idle` right after the turn still lets us read the last committed turn from
  // the session log and run the same job exactly once per turn.
  ctx.on('agent/status', payload => {
    try {
      if (disposed) return
      if (payload?.status !== 'idle') return
      const sessionId = payload?.agent?.id
      if (!sessionId) return
      const session = sessions.get(sessionId)
      if (!session) {
        debugLog({ phase: 'agent-idle-no-session', sessionId })
        return
      }
      let events = []
      try {
        events = Array.from(session.snapshotEvents(Math.max(0, Number(session.seq ?? 0) - 120)) ?? [])
      } catch {
        events = []
      }
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type !== 'turn/end') continue
        debugLog({ phase: 'agent-idle-turn-end', sessionId, turn: event.data?.turn, reason: event.data?.reason?.kind })
        if (event.data?.reason?.kind === 'completed') triggerTurnEnd(session, event.seq, event.data?.turn, 'agent/status-idle')
        return
      }
      debugLog({ phase: 'agent-idle-no-turn-end', sessionId })
    } catch (error) {
      debugLog({ phase: 'agent-status-error', error: String(error) })
    }
  })

  ctx.on('agent/turn-stopping', payload => {
    try {
      debugLog({ phase: 'turn-stopping', sessionId: payload?.agent?.id, turn: payload?.turn })
    } catch {
      /* ignore */
    }
  })

  // ── HTTP routes for the Client half ──────────────────────────────────────
  const handleRouteUnsafe = async (req, res) => {
          let connection
          try { connection = services.connection } catch { /* unavailable */ }
          const rejected = requestRejection(connection, req)
          if (rejected !== undefined) {
            jsonResponse(res, rejected, { ok: false, error: rejected === 503 ? 'auth-unavailable' : 'request-rejected' })
            return
          }
          let url = null
          try {
            url = new URL(req.url, 'http://127.0.0.1')
          } catch {
            url = null
          }
          const pathname = url?.pathname ?? String(req.url ?? '')
          const method = String(req.method ?? 'GET').toUpperCase()
          debug.requestCount = (debug.requestCount ?? 0) + 1
          if (debug.requestCount <= 200) {
            debugLog({
              phase: 'http',
              method,
              pathname,
              query: url?.search ?? '',
              ua: String(req.headers?.['user-agent'] ?? '').slice(0, 48),
              cookie: Boolean(req.headers?.cookie),
            })
          }

          if (method === 'OPTIONS') {
            jsonResponse(res, 204, {})
            return
          }
          if (pathname === `${ROUTE_PREFIX}warm` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const sessionId = String(body.sessionId ?? '')
            if (!sessionId) {
              jsonResponse(res, 200, { ok: false, reason: 'no-session-id' })
              return
            }
            const outcome = await runWarmBackfill(sessionId, { force: body.force === true })
            jsonResponse(res, 200, outcome)
            return
          }
          if (pathname === `${ROUTE_PREFIX}verify` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const sessionId = String(body.sessionId ?? '')
            if (!sessionId) {
              jsonResponse(res, 200, { ok: false, error: 'no-session-id' })
              return
            }
            await hydrateSession(sessionId)
            const plan = states.get(sessionId)?.plan ?? null
            if (!plan) {
              jsonResponse(res, 200, { ok: false, error: 'no-plan' })
              return
            }
            if (!settings.modelCalls) {
              jsonResponse(res, 200, { ok: false, error: 'model-disabled' })
              return
            }
            if (verifyInflight.has(sessionId)) {
              jsonResponse(res, 200, { ok: false, error: 'in-progress' })
              return
            }
            const route = await pickModel(services)
            if (!route) {
              jsonResponse(res, 200, { ok: false, error: 'no-model-route' })
              return
            }
            const session = sessions.get(sessionId) ?? null
            let events = []
            try {
              if (session) {
                events = Array.from(session.snapshotEvents(Math.max(0, Number(session.seq ?? 0) - 300)) ?? [])
              }
            } catch {
              events = []
            }
            const evidence = (() => {
              try {
                const collected = collectFromEvents({
                  events,
                  plan,
                  turn: Number(plan.watermark?.turn ?? 0),
                  sessionId,
                })
                if (collected && collected.ok !== false) return collected
              } catch {
                /* fall through to the plan-only payload */
              }
              return { plan, turn: Number(plan.watermark?.turn ?? 0), lastAssistantText: '', lastUserMessages: [] }
            })()
            verifyInflight.add(sessionId)
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(new Error('verify-deadline')), 8000)
            const startedAt = Date.now()
            try {
              const prompt = buildVerifyPrompt(evidence)
              prompt.maxTokens = settings.maxTokensVerify
              const response = await callModel(services, route, prompt, controller.signal)
              const text = String(response?.text ?? '')
              if (!text) {
                jsonResponse(res, 200, { ok: false, error: 'empty-model-output' })
                return
              }
              const parsed = parseVerifyOutput(text)
              if (!parsed.ok) {
                debugLog({ phase: 'verify-parse-failed', sessionId, code: parsed.code })
                jsonResponse(res, 200, { ok: false, error: 'parse-failed', code: parsed.code })
                return
              }
              debugLog({
                phase: 'verify-done',
                sessionId,
                elapsed: Date.now() - startedAt,
                mismatches: parsed.output.mismatches.length,
              })
              jsonResponse(res, 200, {
                ok: true,
                ...parsed.output,
                usage: response?.usage ?? null,
                elapsedMs: Date.now() - startedAt,
              })
            } catch (error) {
              debugLog({ phase: 'verify-error', sessionId, error: String(error) })
              jsonResponse(res, 200, { ok: false, error: 'model-error' })
            } finally {
              clearTimeout(timer)
              verifyInflight.delete(sessionId)
            }
            return
          }
          if (pathname === `${ROUTE_PREFIX}state` && method === 'GET') {
            const sessionId = url?.searchParams?.get('sessionId') ?? ''
            await hydrateSession(sessionId)
            jsonResponse(res, 200, publicView(sessionId))
            return
          }
          if (pathname === `${ROUTE_PREFIX}debug` && method === 'GET') {
            const probeSessionId = url?.searchParams?.get('sessionId') ?? ''
            const logTail = (() => {
              if (!probeSessionId) return null
              const session = sessions.get(probeSessionId)
              if (!session) return null
              try {
                const from = Math.max(0, Number(session.seq ?? 0) - 60)
                return Array.from(session.snapshotEvents(from) ?? []).map(event => `${event.seq}:${event.type}`)
              } catch (error) {
                return [`error:${String(error)}`]
              }
            })()
            jsonResponse(res, 200, {
              ...debug,
              sessions: Array.from(sessions.keys()),
              states: Array.from(states.keys()),
              probeSessionId,
              logTail,
            })
            return
          }
          if (pathname === `${ROUTE_PREFIX}replan` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const sessionId = String(body.sessionId ?? '')
            const session = sessions.get(sessionId)
            if (!session) {
              jsonResponse(res, 200, { ok: false, error: 'session-not-observed' })
              return
            }
            const turn = Number(states.get(sessionId)?.plan?.watermark?.turn ?? 0)
            void runGeneration(
              session,
              { seq: Number(debug.lastTurnEnd?.seq ?? 0), data: { turn } },
              { force: true, instruction: typeof body.instruction === 'string' ? body.instruction : '' },
            )
            jsonResponse(res, 200, { ok: true, queued: true })
            return
          }
          if (pathname === `${ROUTE_PREFIX}diag` && method === 'GET') {
            jsonResponse(res, 200, { ok: true, lastDiag: debug.lastDiag ?? null })
            return
          }
          if (pathname === `${ROUTE_PREFIX}diag` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            debug.lastDiag = { at: Date.now(), body: safeDiagnostics(body) }
            debugLog({ phase: 'client-diag' })
            jsonResponse(res, 200, { ok: true })
            return
          }
          if (pathname === `${ROUTE_PREFIX}autojob` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const sessionId = String(body.sessionId ?? '')
            const session = sessions.get(sessionId)
            if (!session) {
              jsonResponse(res, 200, { ok: false, error: 'session-not-observed' })
              return
            }
            if (!states.get(sessionId)?.plan) {
              jsonResponse(res, 200, { ok: false, error: 'no-plan' })
              return
            }
            const baseTurn = Number(states.get(sessionId)?.plan?.watermark?.turn ?? 0)
            const startedAt = Date.now()
            try {
              await runGeneration(
                session,
                { seq: Number(session.seq ?? 0), data: { turn: baseTurn + 1 } },
                { force: false },
              )
            } catch (error) {
              debugLog({ phase: 'autojob-error', sessionId, error: String(error) })
            }
            const view = publicView(sessionId)
            jsonResponse(res, 200, {
              ok: true,
              elapsedMs: Date.now() - startedAt,
              usage: debug.lastUsage ?? null,
              version: view.version,
              suggestion: view.suggestion,
              stepCount: Array.isArray(view.steps) ? view.steps.length : 0,
              reason: view.reason,
              lastJob: debug.lastJob ?? null,
            })
            return
          }
          if (pathname === `${ROUTE_PREFIX}reset` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const sessionId = String(body.sessionId ?? '')
            const existed = states.has(sessionId)
            inflight.get(sessionId)?.abort(new Error('state-reset'))
            try {
              await store.clear(sessionId)
            } catch (error) {
              debugLog({ phase: 'reset-store-error', sessionId, error: String(error) })
            }
            hydration.delete(sessionId)
            states.delete(sessionId)
            warmAttempts.delete(sessionId)
            handledTurns.delete(sessionId)
            noneStreaks.delete(sessionId)
            debugLog({ phase: 'state-reset', sessionId, existed })
            jsonResponse(res, 200, { ok: true, sessionId, existed })
            return
          }
          if (pathname === `${ROUTE_PREFIX}steps` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const sessionId = String(body.sessionId ?? '')
            await hydrateSession(sessionId)
            const plan = states.get(sessionId)?.plan ?? null
            if (!plan) {
              jsonResponse(res, 200, { ok: false, error: 'no-plan' })
              return
            }
            const allowed = ['todo', 'doing', 'done', 'dropped']
            let nextSteps = null
            let editReason = ''
            if (Array.isArray(body.steps) && body.steps.length) {
              // Whole-plan user edit (used by /replan-free "整理并更新计划" requests).
              nextSteps = body.steps
                .map((step, index) => ({
                  id: String(step?.id ?? `s${index + 1}`),
                  title: String(step?.title ?? '').slice(0, 160),
                  status: allowed.includes(String(step?.status)) ? String(step.status) : 'todo',
                  source: 'user',
                }))
                .filter(step => step.title)
              editReason = typeof body.reason === 'string' && body.reason.trim()
                ? body.reason.trim()
                : '用户整理并更新计划'
            } else {
              const stepId = String(body.stepId ?? '')
              const status = String(body.status ?? 'done')
              if (!allowed.includes(status)) {
                jsonResponse(res, 200, { ok: false, error: 'bad-status' })
                return
              }
              nextSteps = (plan.steps || []).map(step => (
                step.id === stepId ? { ...step, status, source: 'user' } : step
              ))
              if (!nextSteps.some(step => step.id === stepId)) {
                jsonResponse(res, 200, { ok: false, error: 'unknown-step', stepId })
                return
              }
              editReason = typeof body.reason === 'string' && body.reason.trim()
                ? body.reason.trim()
                : `用户手动标记 ${stepId} 为 ${status}`
            }
            const edit = { steps: nextSteps }
            if (typeof body.intent === 'string' && body.intent.trim()) edit.intent = body.intent.trim().slice(0, 200)
            const applied = applyUserEdit(plan, edit, {
              reason: editReason,
              watermark: plan.watermark,
              now: Date.now(),
            })
            if (!applied?.ok) {
              jsonResponse(res, 200, { ok: false, error: 'apply-failed', detail: applied })
              return
            }
            try {
              const committed = await store.put(applied.plan, {
                cas: plan.version,
                suggestion: states.get(sessionId)?.suggestion ?? null,
              })
              if (!committed) await store.put(applied.plan, { suggestion: states.get(sessionId)?.suggestion ?? null })
            } catch (error) {
              debugLog({ phase: 'user-edit-store-error', sessionId, error: String(error) })
            }
            const previous = states.get(sessionId)
            publishState(sessionId, {
              plan: applied.plan,
              suggestion: previous?.suggestion ?? null,
              stale: false,
            })
            debugLog({ phase: 'user-edit', sessionId, stepCount: nextSteps.length, version: applied.plan.version })
            jsonResponse(res, 200, {
              ok: true,
              changed: applied.changed === true,
              version: applied.plan.version,
              editedByUser: applied.plan.editedByUser === true,
              steps: applied.plan.steps,
            })
            return
          }
          if (pathname === `${ROUTE_PREFIX}experiment` && method === 'GET') {
            jsonResponse(res, 200, {
              running: experimentState.running,
              error: experimentState.error,
              result: experimentState.result,
            })
            return
          }
          if (pathname === `${ROUTE_PREFIX}experiment` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            if (experimentState.running) {
              jsonResponse(res, 200, { ok: true, running: true })
              return
            }
            const sessionId = String(body.sessionId ?? '')
            const session = sessions.get(sessionId)
            if (!session) {
              jsonResponse(res, 200, { ok: false, error: 'session-not-observed' })
              return
            }
            const basePlan = states.get(sessionId)?.plan ?? null
            if (!basePlan) {
              jsonResponse(res, 200, { ok: false, error: 'no-plan' })
              return
            }
            experimentState.running = true
            experimentState.result = null
            experimentState.error = null
            void (async () => {
              try {
                const route = await pickModel(services)
                if (!route) throw new Error('no-model-route')
                const judgeRoute = await pickJudgeRoute(services, route)
                debugLog({ phase: 'experiment-start', sessionId, route, judgeRoute })
                const result = await runExperiment({
                  services,
                  route,
                  judgeRoute,
                  session,
                  sessionId,
                  basePlan,
                  collectFromEvents,
                  buildPatchPrompt,
                  parseModelOutput,
                  callModel,
                  debugLog,
                  evidenceChars: body.evidenceChars,
                  maxTokens: body.maxTokens,
                  reps: body.reps,
                  onProgress: (index, total, variant) => debugLog({
                    phase: 'experiment-progress',
                    index,
                    total,
                    windowSize: variant?.windowSize,
                    maxTokens: variant?.maxTokens,
                  }),
                })
                experimentState.result = result
                try {
                  if (debugDir) {
                    mkdirSync(debugDir, { recursive: true })
                    writeFileSync(`${debugDir}\\plan-completion-experiment.json`, JSON.stringify(result, null, 2), 'utf8')
                  }
                } catch (error) {
                  /* ignore */
                }
                debugLog({ phase: 'experiment-done', total: result.total })
              } catch (error) {
                experimentState.error = String(error)
                debugLog({ phase: 'experiment-failed', error: String(error) })
              } finally {
                experimentState.running = false
              }
            })()
            jsonResponse(res, 200, { ok: true, started: true, planSteps: Array.isArray(basePlan.steps) ? basePlan.steps.length : 0 })
            return
          }
          if (pathname === `${ROUTE_PREFIX}theme` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const mode = typeof body.mode === 'string' ? body.mode : null
            debugTheme = mode === 'dark' || mode === 'light' || mode === 'system' ? mode : null
            debugLog({ phase: 'theme-request', mode: debugTheme })
            jsonResponse(res, 200, { ok: true, theme: debugTheme })
            return
          }
          jsonResponse(res, 404, { ok: false, error: 'unknown-route', pathname })
  }

  // Defense in depth: an unexpected throw must still close the HTTP response instead
  // of leaving the client fetch hanging.
  const handleRoute = async (req, res) => {
    try {
      await handleRouteUnsafe(req, res)
    } catch (error) {
      try {
        jsonResponse(res, 500, { ok: false, error: 'internal-error' })
      } catch {
        /* ignore */
      }
      try {
        debugLog({ phase: 'route-error', method: String(req?.method ?? ''), error: true })
      } catch {
        /* ignore */
      }
    }
  }

  // The shipped web server matches only routes already registered for the request path;
  // register one exact route per endpoint (verified working with the runtime probe).
  // `ctx.inject` defers this until the webServer service exists (cold boot ordering).
  ctx.inject(['webServer'], child => {
    const web = child.webServer
    if (!web?.register) {
      debugLog({ phase: 'route-register-skipped', reason: 'webServer unavailable' })
      return
    }
    // Production endpoints are always registered; development/debug endpoints require
    // `config.enableDebugRoutes: true` so a published bundle exposes a minimal surface.
    const paths = [
      `${ROUTE_PREFIX}state`,
      `${ROUTE_PREFIX}replan`,
      `${ROUTE_PREFIX}warm`,
      `${ROUTE_PREFIX}verify`,
    ]
    if (settings.enableDebugRoutes) {
      paths.push(
        `${ROUTE_PREFIX}debug`,
        `${ROUTE_PREFIX}diag`,
        `${ROUTE_PREFIX}theme`,
        `${ROUTE_PREFIX}experiment`,
        `${ROUTE_PREFIX}autojob`,
        `${ROUTE_PREFIX}steps`,
        `${ROUTE_PREFIX}reset`,
      )
    }
    const handles = []
    // Dispose route handlers registered by a previous instance of this plugin (toggle/reload).
    for (const dispose of shared.disposers.splice(0, shared.disposers.length)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    try {
      for (const path of paths) {
        handles.push(web.register({ kind: 'exact', path, handler: handleRoute }))
      }
      for (const dispose of handles) shared.disposers.push(dispose)
      debugLog({ phase: 'routes-registered', paths })
    } catch (error) {
      debugLog({ phase: 'route-register-error', error: String(error) })
    }
    child.effect(() => () => {
      for (const dispose of handles) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    })
  })

  // ── Human commands ────────────────────────────────────────────────────────
  ctx.inject(['commands'], child => {
    const commands = child.commands
  if (commands?.register) {
    const disposers = []
    try {
      disposers.push(commands.register({
        name: 'roadmap',
        description: '查看当前会话的隐式计划（只读）',
        handler: invocation => {
          const view = publicView(invocation?.agent?.id ?? '')
          if (!view.plan) return { kind: 'success', text: '当前会话还没有计划。下一次回合结束后会自动生成。' }
          const lines = [`会话计划 v${view.version?.gen ?? 0}.${view.version?.rev ?? 0} · ${view.status ?? ''}`]
          if (view.intent) lines.push(`目标：${view.intent}`)
          for (const step of view.steps) {
            const mark = step.status === 'done' ? '✓' : step.status === 'doing' ? '●' : step.status === 'dropped' ? '×' : '○'
            lines.push(`${mark} ${step.title}`)
          }
          if (view.reason) lines.push(`更新原因：${view.reason}`)
          if (view.suggestion?.text) lines.push(`下一步建议：${view.suggestion.text}`)
          return { kind: 'success', text: lines.join('\n') }
        },
      }))
      disposers.push(commands.register({
        name: 'replan',
        description: '强制重写当前会话的隐式计划',
        input: { hint: '可选：一句话说明新的方向' },
        handler: invocation => {
          const sessionId = invocation?.agent?.id ?? ''
          const session = sessions.get(sessionId)
          if (!session) return { kind: 'error', text: '还没有观察到这个会话，请先在会话里发一条消息。' }
          const turn = Number(states.get(sessionId)?.plan?.watermark?.turn ?? 0)
          void runGeneration(
            session,
            { seq: Number(debug.lastTurnEnd?.seq ?? 0), data: { turn } },
            { force: true, instruction: String(invocation?.rawInput ?? '') },
          )
          return { kind: 'success', text: '计划重写已开始…' }
        },
      }))
      child.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      })
    } catch (error) {
      debugLog({ phase: 'command-register-error', error: String(error) })
    }
  }
  })

  debugLog({
    phase: 'host-ready',
    settings,
    config: rawConfig,
    services: Object.fromEntries(Object.entries(services).map(([key, value]) => [key, Boolean(value)])),
  })
}

