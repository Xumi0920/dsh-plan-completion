import { appendFileSync, mkdirSync } from 'node:fs'

import { collectRetrievalRecords } from './rag-evidence.js'
import { lifecycleChanges } from './progress.js'

import { DEFAULTS } from './config.js'
import { safeDebugRecord } from './security.js'
import { join } from 'node:path'
import { normalizePlan, patchPlan, statusFor } from './plan.js'

import { heuristicSuggestion, fallbackPlan } from './heuristics.js'

import { createMemoryStore, createFileStore } from './store.js'

import { expandStorageDir, normalizeModelPolicy, readSavedSettings } from './settings.js'

export function createCore(ctx, config = {}) {
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

  // Default helper budgets; they do not override the main Agent context or output limits.
  //   evidenceChars      1500  — compact evidence slice for the patch path
  //   maxTokensPatch      800  — structured progress and acceptance proposals
  //   maxTokensRewrite   1200  — rewrite must emit the full step table
  const readInt = (value, fallback, min, max) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.min(max, Math.max(min, number))
  }
  const rawConfig = config && typeof config === 'object' ? { ...config } : {}
  const storageDir = expandStorageDir(rawConfig.storageDir, process.env.DSH_PLAN_COMPLETION_STORE_DIR)
  const savedSettings = readSavedSettings(storageDir)
  rawConfig.rag = { ...rawConfig.rag, ...savedSettings.rag }
  const settings = {
    progressProtocol: (savedSettings.progressProtocol ?? rawConfig.progressProtocol) === 'strict' ? 'strict' : 'legacy',
    evidenceChars: readInt(rawConfig.evidenceChars, 1500, 400, 8000),
    maxTokensPatch: readInt(rawConfig.maxTokensPatch, 800, 120, 4000),
    maxTokensRewrite: readInt(rawConfig.maxTokensRewrite, 1200, 400, 8000),
    warmBackfill: rawConfig.warmBackfill !== false,
    modelCalls: (typeof savedSettings.modelCalls === 'boolean' ? savedSettings.modelCalls : true) && rawConfig.modelCalls !== false,
    modelPolicy: normalizeModelPolicy(savedSettings.modelPolicy ?? rawConfig.modelPolicy),
    fixedProvider: String(savedSettings.fixedProvider ?? rawConfig.fixedProvider ?? '').trim().slice(0, 120),
    fixedModel: String(savedSettings.fixedModel ?? rawConfig.fixedModel ?? '').trim().slice(0, 120),
    persistPlans: rawConfig.persistPlans !== false,
    storageDir,
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

  const shared = { states: new Map(), sessions: new Map(), handledTurns: new Map(), warmAttempts: new Map(), noneStreaks: new Map(), disposers: [] }
  const states = shared.states // sessionId -> { plan, suggestion, stale }
  const sessions = shared.sessions // sessionId -> Session
  const warmAttempts = shared.warmAttempts // sessionId -> { at, seq }
  const inflight = new Map() // sessionId -> AbortController
  const verifyInflight = new Map() // sessionId -> 正在核对（同一会话同时只允许一个）
  // Persistence: a file-backed plan store when a directory is configured; otherwise memory.
  // The store keeps the last plan + suggestion per session so a restart can restore the UI.
  const fileStore = settings.persistPlans && settings.storageDir ? createFileStore(settings.storageDir) : null
  const store = fileStore ?? createMemoryStore()
  shared.store = store
  const emptyRag = { settings: { enabled: false, sendContextToGenerator: false }, sync() {}, clear() {}, forget() {}, close() {}, async retrieve() { return { mode: 'disabled', records: [], elapsedMs: 0, indexed: 0 } } }
  let retrieval = emptyRag
  const rag = new Proxy({}, { get(_target, key) { const value = retrieval[key]; return typeof value === 'function' ? value.bind(retrieval) : value } })
  const observeTimers = new Map()
  const resetAfter = new Map()
  const ragViews = new Map()
  let disposed = false
  const stopGeneration = () => {
    disposed = true
    for (const controller of inflight.values()) controller.abort(new Error('plugin-disposed'))
    inflight.clear()
    for (const controller of verifyInflight.values()) controller.abort(new Error('plugin-disposed'))
    verifyInflight.clear()
    core.cancelModels('core-disposed')
    retrieval.close()
    for (const timer of observeTimers.values()) clearTimeout(timer)
    observeTimers.clear()
    if (shared.stopGeneration === stopGeneration) delete shared.stopGeneration
  }
  shared.stopGeneration = stopGeneration
  ctx.effect(() => stopGeneration)
  const handledTurns = shared.handledTurns, noneStreaks = shared.noneStreaks
  const debug = { lastTurnEnd: null, lastJob: null, model: null }
  const presentation = { debugTheme: null }
  const experimentState = { running: false, result: null, error: null }

  const publicView = sessionId => {
    const state = states.get(sessionId)
    let plan = state?.plan ?? null
    if (plan && (state?.freshness === 'journal-unavailable' || !core.components.observer)) {
      const steps = plan.steps.map(s => s.source === 'user' ? s : { ...s, status: s.status === 'done' ? 'todo' : s.status, proof: null, lifecycle: 'journal_unavailable' })
      plan = { ...plan, steps, status: statusFor(steps) }
    }
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
      stale: !core.components.observer || (state ? Boolean(state.stale) : true),
      freshness: !core.components.observer ? 'observer-disabled' : state?.freshness ?? 'live',
      constraints: plan?.constraints ?? [],
      retrieval: ragViews.get(sessionId) ?? { mode: rag.settings.enabled ? 'warming' : 'disabled' },
      debugTheme: presentation.debugTheme,
      components: { ...core.components },
      assurance: settings.progressProtocol === 'legacy' && !plan?.steps.some(s => s.acceptance) ? 'legacy-unverified' : 'validated',
      embedding: core.embeddingSnapshot?.() ?? { state: 'disabled' },
    }
  }

  async function settingsSnapshot(providerHint = '') {
    const selection = services.agentDefaultModel?.currentSelection?.() ?? null
    let providers = []
    try {
      providers = services.llm?.listProviders?.() ?? []
    } catch {
      providers = []
    }
    let models = []
    let modelsProvider = ''
    try {
      modelsProvider = providerHint || selection?.provider || (Array.isArray(providers) ? providers[0]?.id : '')
      if (modelsProvider && typeof services.llm?.listModels === 'function') {
        models = (await services.llm.listModels(modelsProvider))?.map(m => ({ provider: modelsProvider, id: m?.id ?? '', name: m?.name ?? m?.id ?? '' })) ?? []
      }
    } catch { models = [] }
    return {
      progressProtocol: settings.progressProtocol,
      modelPolicy: settings.modelPolicy,
      fixedProvider: settings.fixedProvider,
      fixedModel: settings.fixedModel,
      modelCalls: settings.modelCalls,
      defaultSelection: selection && selection.provider && selection.model
        ? { provider: selection.provider, model: selection.model }
        : null,
      models,
      modelsProvider,
      providers: Array.isArray(providers)
        ? providers.map(provider => ({ id: provider?.id ?? '', name: provider?.name ?? provider?.id ?? '' }))
        : [],
    }
  }

  function publishState(sessionId, patch) {
    const previous = states.get(sessionId) ?? { plan: null, suggestion: null, stale: false }
    states.set(sessionId, { ...previous, ...patch })
  }

  // ── Persistence ⇄ in-memory state ────────────────────────────────────────
  const hydration = new Map() // sessionId -> Promise (in-flight disk reads)

  /**
   * Load a persisted plan (+ last suggestion) into the shared in-memory state. The UI can show
   * the previous plan right after a DSH restart, before the next turn runs.
   */
  async function hydrateSession(sessionId) {
    if (!sessionId) return
    if (states.get(sessionId)?.plan) {
      if (states.get(sessionId).freshness === 'journal-unavailable') await reconcileSession(sessionId)
      return
    }
    const pending = hydration.get(sessionId)
    if (pending) return pending
    const task = (async () => {
      try {
        const stored = typeof store.getState === 'function'
          ? await store.getState(sessionId)
          : { plan: await store.get(sessionId), suggestion: null }
        if (disposed || !stored?.plan || states.get(sessionId)?.plan) return
        const normalized = normalizePlan(stored.plan)
        if (!normalized?.ok || !normalized.plan) return
        // Legacy storage remains readable, but unversioned machine status is
        // not promoted to verified completion during migration.
        normalized.plan.steps = normalized.plan.steps.map(s => settings.progressProtocol !== 'strict' || s.acceptance || s.source === 'user' ? s : {
          ...s, status: 'todo', proof: null, evidence: [], lifecycle: 'awaiting_manual_acceptance',
          acceptance: { scope: 'manual', revision: 1, afterSeq: Number(normalized.plan.watermark?.seq ?? -1), dependsOn: [] },
        })
        normalized.plan.status = statusFor(normalized.plan.steps)
        states.set(sessionId, {
          plan: normalized.plan,
          suggestion: stored.suggestion && typeof stored.suggestion === 'object' ? stored.suggestion : null,
          stale: true,
          freshness: 'journal-unavailable',
        })
        await reconcileSession(sessionId)
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

  // Saved proof is a cache. Only the native journal can refresh completion.
  async function reconcileSession(sessionId, suppliedEvents, { upgradeLegacy = false } = {}) {
    const state = states.get(sessionId)
    if (disposed || !state?.plan) return false
    if (settings.progressProtocol === 'legacy' && !state.plan.steps.some(s => s.acceptance)) {
      publishState(sessionId, { stale: false, freshness: 'legacy-unverified' }); return true
    }
    if (upgradeLegacy && settings.progressProtocol === 'strict' && state.plan.steps.some(s => !s.acceptance && s.source !== 'user')) {
      const changes = state.plan.steps.filter(s => !s.acceptance && s.source !== 'user').map(s => ({ id: s.id, status: 'todo', proof: null, evidence: [],
        lifecycle: 'awaiting_manual_acceptance', acceptance: { scope: 'manual', revision: 1, afterSeq: state.plan.watermark.seq, dependsOn: [] } }))
      const upgraded = patchPlan(state.plan, changes, { reason: '启用严格验收；旧模型状态待人工核验' })
      if (!upgraded.ok || !await store.put(upgraded.plan, { cas: state.plan.version, suggestion: state.suggestion })) return false
      if (states.get(sessionId)?.plan !== state.plan) return false
      publishState(sessionId, { plan: upgraded.plan, stale: true, freshness: 'journal-unavailable' })
      return reconcileSession(sessionId, suppliedEvents)
    }
    let events = suppliedEvents
    if (!events) {
      try { events = sessions.get(sessionId)?.snapshotEvents(resetAfter.get(sessionId) ?? 0) } catch { /* retry persistence */ }
      if (!events) events = await loadStoredEvents(sessionId, 32768)
    }
    if (disposed || !events || states.get(sessionId)?.plan !== state.plan) return false
    const records = collectRetrievalRecords(sessionId, Array.from(events), { maxRecords: 32768 })
    const changes = lifecycleChanges(state.plan, records)
    let plan = state.plan
    if (changes.length) {
      const result = patchPlan(plan, changes, { reason: '按原生日志重新核验', watermark: plan.watermark })
      if (!result.ok) return false
      plan = result.plan
    }
    publishState(sessionId, { plan, stale: false, freshness: 'journal-checked' })
    if (plan !== state.plan) await store.put(plan, { cas: state.plan.version, suggestion: state.suggestion ?? null })
    return true
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
      steps: settings.progressProtocol === 'legacy' ? steps : steps.map(s => ({ ...s, status: 'todo', acceptance: { scope: 'manual', revision: 1, afterSeq: Number(evidence?.watermark?.seq ?? -1), dependsOn: [] }, lifecycle: 'awaiting_manual_acceptance' })),
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
      let total = null
      try {
        const stat = await persistence.stat?.(sessionId)
        if (Number.isSafeInteger(stat?.eventCount) && stat.eventCount >= 0) total = stat.eventCount
      } catch { /* unknown count requires complete pagination */ }
      if (total !== null) {
        const page = await handle.read(Math.max(0, total - limit), limit)
        return Array.isArray(page?.events) ? page.events : null
      }
      let offset = 0, events = []
      for (let guard = 0; guard < 256; guard += 1) {
        const page = await handle.read(offset, 400)
        if (!Array.isArray(page?.events)) return null
        const batch = page.events
        events = events.concat(batch).slice(-limit)
        if (batch.length < 400) return events
        offset += batch.length
      }
      // Never certify a partial prefix as the latest history.
      return null
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
    if (!sessionId) return { ok: false, reason: 'no-session-id' }
    await hydrateSession(sessionId)
    if (states.get(sessionId)?.plan) return { ok: true, already: true, revalidated: await reconcileSession(sessionId) }
    if (!settings.warmBackfill) return { ok: false, reason: 'disabled' }
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

  const core = {
    settings, rawConfig, services, shared, states, sessions, warmAttempts, inflight, verifyInflight, store, rag, observeTimers, resetAfter, ragViews, debug, presentation, experimentState, hydration, handledTurns, noneStreaks, readInt, publicView, settingsSnapshot, publishState, hydrateSession, reconcileSession, seedPlan, heuristicText, loadStoredEvents, runWarmBackfill, runGeneration, debugLog,
    components: { core: true, observer: false, generator: false, retrieval: false, api: false },
    get disposed() { return disposed },
    generate: null,
    setRetrieval(value) { retrieval = value ?? emptyRag },
    cancelModels(reason = 'component-stopped') {
      for (const c of [...inflight.values(), ...verifyInflight.values()]) c.abort(new Error(reason))
    },
  }
  async function runGeneration(session, event, options) {
    if (disposed) return
    if (core.generate) return core.generate(session, event, options)
    await hydrateSession(session?.id)
    await reconcileSession(session?.id, session?.snapshotEvents(resetAfter.get(session?.id) ?? 0))
  }
  return core
}
