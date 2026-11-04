

export const inject = ['planCompletion']
export function apply(ctx) { return attach(ctx, ctx.get('planCompletion')) }
export function attach(ctx, core) {
  if (!core || core.components.observer) return
  core.components.observer = true
  const { rawConfig, sessions, inflight, observeTimers, resetAfter, debug, handledTurns, readInt, hydrateSession, reconcileSession, runGeneration, debugLog } = core
  let disposed = false
  ctx.effect(() => () => { disposed = true; core.components.observer = false })
  // Events may have arrived while this component was disabled.
  for (const [id, state] of core.states) {
    state.stale = true; state.freshness = 'journal-unavailable'
    void reconcileSession(id).catch(() => {})
  }
  // ── Session event subscription: one plan job per completed turn ──────────

  function triggerTurnEnd(session, seq, turn, source) {
    if (!session?.id || disposed || core.disposed) return
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
    if (!session?.id || disposed || core.disposed) return
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
    if (!session?.id || disposed || core.disposed) return
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
      if (disposed || core.disposed) return
      debug.eventCount = (debug.eventCount ?? 0) + 1
      debug.eventTypes = debug.eventTypes ?? {}
      const type = String(event?.type ?? 'unknown')
      debug.eventTypes[type] = (debug.eventTypes[type] ?? 0) + 1
      if (debug.eventCount <= 12) debugLog({ phase: 'session-event', type, sessionId: session?.id })
      if (!session?.id) return
      sessions.set(session.id, session)
      if (['tool/call','tool/result','turn/end','compaction/end'].includes(event.type)) {
        void hydrateSession(session.id).then(() => reconcileSession(session.id, session.snapshotEvents(resetAfter.get(session.id) ?? 0))).catch(() => {})
      }
      scheduleIdleCheck(session)
      if (event?.type === 'user/message') {
        inflight.get(session.id)?.abort(new Error('new-user-message'))
        clearTimeout(observeTimers.get(session.id)); observeTimers.delete(session.id)
      }
      if (['tool/call', 'tool/result', 'step/end', 'turn/end', 'compaction/end'].includes(event?.type)) {
        inflight.get(session.id)?.abort(new Error('new-progress-boundary'))
        clearTimeout(observeTimers.get(session.id))
        if (event.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') {
          const timer = setTimeout(() => {
            observeTimers.delete(session.id)
            runGeneration(session, event).catch(() => {})
          }, readInt(rawConfig.observationDebounceMs, 700, 100, 5000))
          observeTimers.set(session.id, timer)
        } else observeTimers.delete(session.id)
      }
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
      if (disposed || core.disposed) return
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

  ctx.effect(() => () => {
    for (const state of core.states.values()) { state.stale = true; state.freshness = 'journal-unavailable' }
    core.cancelModels('observer-disabled')
    for (const timer of observeTimers.values()) clearTimeout(timer)
    observeTimers.clear()
  })

}
