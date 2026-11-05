import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { requestRejection, safeDiagnostics } from './security.js'
import { applyUserEdit } from './plan.js'
import { buildPatchPrompt, parseModelOutput, buildVerifyPrompt, parseVerifyOutput } from './prompt.js'

import { collectFromEvents } from './evidence.js'

import { runExperiment } from './experiment.js'

import { pickModel, callModel, pickJudgeRoute } from './model-route.js'
import { normalizeModelPolicy, writeSavedSettings } from './settings.js'
import { confirmStep } from './confirmation.js'
import { isAbsolute } from 'node:path'

export const inject = ['planCompletion']
export function apply(ctx) { return attach(ctx, ctx.get('planCompletion')) }
export function attach(ctx, core) {
  if (!core || core.components.api) return
  core.components.api = true
  const { settings, services, shared, states, sessions, warmAttempts, inflight, verifyInflight, store, rag, observeTimers, resetAfter, ragViews, debug, presentation, experimentState, hydration, handledTurns, noneStreaks, publicView, settingsSnapshot, publishState, hydrateSession, runWarmBackfill, runGeneration, debugLog } = core
  let disposed = false
  ctx.effect(() => () => { disposed = true; core.components.api = false })
const ROUTE_PREFIX = '/plan-completion/'
const clipLogLine = line => line.length > 400 ? line.slice(0, 400) + '…' : line
async function readRagLog(logPath, tailLines = 60) {
  if (!logPath) return { path: '', size: 0, mtime: null, startup: [], tail: [] }
  try {
    const info = await stat(logPath)
    const text = await readFile(logPath, 'utf8')
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
    return {
      path: logPath,
      size: info.size,
      mtime: info.mtime.toISOString(),
      startup: lines.slice(0, 40).map(clipLogLine),
      tail: lines.slice(-Math.max(10, Math.min(200, tailLines))).map(clipLogLine),
    }
  } catch {
    return { path: logPath, size: 0, mtime: null, startup: [], tail: [] }
  }
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
            if (!settings.modelCalls || !core.components.generator) {
              jsonResponse(res, 200, { ok: false, error: 'model-disabled' })
              return
            }
            if (verifyInflight.has(sessionId)) {
              jsonResponse(res, 200, { ok: false, error: 'in-progress' })
              return
            }
            const route = await pickModel(services, settings)
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
            const controller = new AbortController()
            verifyInflight.set(sessionId, controller)
            const timer = setTimeout(() => controller.abort(new Error('verify-deadline')), 8000)
            const startedAt = Date.now()
            try {
              const prompt = buildVerifyPrompt(evidence)
              prompt.maxTokens = settings.maxTokensVerify
              const response = await callModel(services, route, prompt, controller.signal)
              if (controller.signal.aborted) { jsonResponse(res, 200, { ok: false, error: 'request-cancelled' }); return }
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
          if (pathname === `${ROUTE_PREFIX}confirm` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
            await hydrateSession(sessionId)
            const plan = states.get(sessionId)?.plan
            const edit = confirmStep(plan, body, { seq: sessions.get(sessionId)?.seq ?? plan?.watermark?.seq ?? 0 })
            if (!edit.ok) { jsonResponse(res, edit.error === 'version-conflict' ? 409 : 400, edit); return }
            if (!edit.unchanged && !await store.put(edit.plan, { cas: plan.version, suggestion: null })) { jsonResponse(res, 409, { ok: false, error: 'version-conflict' }); return }
            inflight.get(sessionId)?.abort(new Error('user-confirmation')); verifyInflight.get(sessionId)?.abort(new Error('user-confirmation'))
            publishState(sessionId, { plan: edit.plan, suggestion: null })
            await core.reconcileSession(sessionId)
            jsonResponse(res, 200, { ok: true, ...publicView(sessionId) }); return
          }
          if (pathname === `${ROUTE_PREFIX}settings` && method === 'GET') {
            jsonResponse(res, 200, { ok: true, settings: await settingsSnapshot(url?.searchParams?.get('provider') ?? '') })
            return
          }
          if (pathname === `${ROUTE_PREFIX}settings` && method === 'POST') {
            const body = (await readJsonBody(req)) ?? {}
            const next = { ...(await settingsSnapshot()) }
            if (body.progressProtocol !== undefined) {
              if (!['legacy', 'strict'].includes(body.progressProtocol)) { jsonResponse(res, 400, { ok: false, error: 'bad-progress-policy' }); return }
              next.progressProtocol = body.progressProtocol
            }
            if (body.rag !== undefined) {
              if (!body.rag || typeof body.rag !== 'object' || Array.isArray(body.rag)) { jsonResponse(res, 400, { ok: false, error: 'bad-rag-settings' }); return }
              for (const [key, value] of Object.entries(body.rag)) {
                const valid = ['enabled', 'sendContextToGenerator', 'autoManage'].includes(key) ? typeof value === 'boolean'
                  : key === 'backend' ? ['external', 'llama.cpp'].includes(value)
                  : key === 'variant' ? ['auto', 'vulkan', 'cpu'].includes(value)
                  : ['executablePath', 'modelPath', 'installDir'].includes(key) ? typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value) && (!value || isAbsolute(value)) : false
                if (!valid) { jsonResponse(res, 400, { ok: false, error: 'bad-rag-settings' }); return }
                next.rag[key] = value
              }
              // Zero-config default: managed assets are downloaded automatically on first use.
              // Paths are only required when the user explicitly disables managed mode.
              if (next.rag.enabled && next.rag.backend === 'llama.cpp' && next.rag.autoManage === false
                && (!next.rag.executablePath || !next.rag.modelPath)) { jsonResponse(res, 400, { ok: false, error: 'embedding-paths-required' }); return }
            }
            if (body.modelPolicy !== undefined) {
              const policy = normalizeModelPolicy(body.modelPolicy)
              if (policy !== String(body.modelPolicy).trim()) {
                jsonResponse(res, 200, { ok: false, error: 'bad-model-policy' })
                return
              }
              next.modelPolicy = policy
            }
            if (body.modelCalls !== undefined) {
              if (typeof body.modelCalls !== 'boolean') {
                jsonResponse(res, 200, { ok: false, error: 'bad-model-calls' })
                return
              }
              next.modelCalls = body.modelCalls
            }
            for (const key of ['fixedProvider', 'fixedModel']) {
              if (body[key] === undefined) continue
              if (typeof body[key] !== 'string') {
                jsonResponse(res, 200, { ok: false, error: 'bad-' + key })
                return
              }
              next[key] = body[key].trim().slice(0, 120)
            }
            if (next.modelPolicy === 'fixed' && (!next.fixedProvider || !next.fixedModel)) {
              jsonResponse(res, 200, { ok: false, error: 'missing-fixed-route' })
              return
            }
            core.cancelModels('model-policy-changed')
            settings.modelPolicy = next.modelPolicy
            settings.fixedProvider = next.fixedProvider
            settings.fixedModel = next.fixedModel
            settings.modelCalls = next.modelCalls
            settings.progressProtocol = next.progressProtocol
            const ragChanged = JSON.stringify((await settingsSnapshot()).rag) !== JSON.stringify(next.rag)
            core.rawConfig.rag = { ...core.rawConfig.rag, ...next.rag }
            if (ragChanged) core.restartRetrieval?.()
            // First enable starts the zero-config managed setup in the background so the
            // settings page can render download/start progress immediately.
            if (ragChanged && next.rag.enabled && next.rag.backend === 'llama.cpp') {
              void Promise.resolve().then(() => core.prepareEmbeddings?.()).catch(() => {})
            }
            if (body.progressProtocol === 'strict') for (const id of states.keys()) await core.reconcileSession(id, undefined, { upgradeLegacy: true })
            if (!settings.modelCalls) {
              for (const controller of inflight.values()) controller.abort(new Error('model-disabled'))
              rag.clear(); ragViews.clear()
            }
            const saved = writeSavedSettings(settings.storageDir, {
              modelPolicy: settings.modelPolicy,
              fixedProvider: settings.fixedProvider,
              fixedModel: settings.fixedModel,
              modelCalls: settings.modelCalls,
              progressProtocol: settings.progressProtocol,
              rag: core.rawConfig.rag,
            })
            debugLog({ phase: 'settings-updated', modelPolicy: settings.modelPolicy, saved })
            jsonResponse(res, 200, { ok: true, saved, settings: await settingsSnapshot() })
            return
          }
          if (pathname === `${ROUTE_PREFIX}rag/prepare` && method === 'POST') {
            if (typeof core.prepareEmbeddings !== 'function') { jsonResponse(res, 400, { ok: false, error: 'retrieval-unavailable' }); return }
            void Promise.resolve().then(() => core.prepareEmbeddings()).catch(() => {})
            jsonResponse(res, 202, { ok: true, embedding: core.embeddingSnapshot?.() ?? { state: 'disabled' } })
            return
          }
          if (pathname === `${ROUTE_PREFIX}rag/status` && method === 'GET') {
            const embedding = core.embeddingSnapshot?.() ?? { state: 'disabled' }
            const settingsNow = await settingsSnapshot()
            const requested = Number(url?.searchParams?.get('tail') ?? url?.searchParams?.get('lines'))
            const tailLines = Number.isFinite(requested) && requested > 0 ? Math.min(1000, Math.max(10, Math.trunc(requested))) : 200
            const log = await readRagLog(embedding.logPath ?? '', tailLines)
            const process = {
              running: embedding.state === 'ready',
              state: embedding.state ?? 'disabled',
              pid: embedding.pid ?? null,
              port: embedding.port ?? null,
              variant: embedding.variant ?? null,
              managed: embedding.managed === true,
              source: embedding.source ?? '',
              executablePath: embedding.executablePath ?? '',
              modelPath: embedding.modelPath ?? '',
              logPath: embedding.logPath ?? '',
              starts: embedding.starts ?? 0,
              uptimeMs: embedding.uptimeMs ?? 0,
              startedAt: embedding.startedAt ?? null,
              error: embedding.error ?? null,
            }
            jsonResponse(res, 200, {
              ok: true,
              rag: settingsNow.rag,
              process,
              embedding,
              prepareAvailable: typeof core.prepareEmbeddings === 'function',
              log: { ...log, tailLines },
              // Convenience alias for callers that only want the latest log lines.
              logTail: log.tail,
            })
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
            debugLog({ phase: 'client-diag-' + String(body?.build ?? '') })
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
            clearTimeout(observeTimers.get(sessionId)); observeTimers.delete(sessionId)
            rag.forget(sessionId); ragViews.delete(sessionId)
            resetAfter.set(sessionId, Number(sessions.get(sessionId)?.seq ?? 0) + 1)
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
                const route = await pickModel(services, settings)
                if (!route) { suggestion = { text: settings.modelPolicy === 'fixed' ? '固定模型不可用，请检查模型设置' : '模型不可用，暂用本地状态校验', alternates: [] }; throw new Error('no-model-route') }
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
                  if (settings.debugDir) {
                    mkdirSync(settings.debugDir, { recursive: true })
                    writeFileSync(`${settings.debugDir}\\plan-completion-experiment.json`, JSON.stringify(result, null, 2), 'utf8')
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
            presentation.debugTheme = mode === 'dark' || mode === 'light' || mode === 'system' ? mode : null
            debugLog({ phase: 'theme-request', mode: presentation.debugTheme })
            jsonResponse(res, 200, { ok: true, theme: presentation.debugTheme })
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
      `${ROUTE_PREFIX}settings`,
      `${ROUTE_PREFIX}confirm`,
      `${ROUTE_PREFIX}rag/status`,
      `${ROUTE_PREFIX}rag/prepare`,
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

  ctx.effect(() => () => { for (const c of verifyInflight.values()) c.abort(new Error('api-disabled')) })

}
