import { createRag } from './rag.js'
import { createManagedEmbeddingClient, embeddingBackend } from './embedding-runtime.js'
export const inject = ['planCompletion']
export function apply(ctx) { return attach(ctx, ctx.get('planCompletion')) }
export function attach(ctx, core) {
  if (!core || core.components.retrieval) return
  let rag, managed, previousClose = Promise.resolve()
  function restart() {
    core.cancelModels('retrieval-reconfigured')
    rag?.close(); const old = managed
    previousClose = Promise.allSettled([previousClose, old?.close()])
    const config = core.rawConfig.rag ?? {}
    managed = config.enabled && embeddingBackend(config) === 'llama.cpp' ? createManagedEmbeddingClient(config) : null
    const owner = managed
    rag = createRag(config, owner ? { client: { async embed(...args) { await previousClose; return owner.embed(...args) }, close: () => owner.close() } } : {})
    core.setRetrieval(rag); core.ragViews.clear()
  }
  core.restartRetrieval = restart
  core.embeddingSnapshot = () => managed?.snapshot() ?? { backend: embeddingBackend(core.rawConfig.rag), state: core.rawConfig.rag?.enabled ? 'external' : 'disabled', owned: false }
  restart()
  core.components.retrieval = true
  ctx.effect(() => async () => {
    core.cancelModels('retrieval-disabled')
    rag.close()
    core.setRetrieval(null)
    core.ragViews.clear()
    core.components.retrieval = false
    if (core.restartRetrieval === restart) core.restartRetrieval = null
    core.embeddingSnapshot = () => ({ state: 'disabled', owned: false })
    await Promise.allSettled([previousClose, managed?.close()])
  })
}
