import { createRag } from './rag.js'
import { createManagedEmbeddingClient, embeddingBackend } from './embedding-runtime.js'
import { resolveAssets } from './rag-assets.js'
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
    managed = config.enabled && embeddingBackend(config) === 'llama.cpp'
      ? createManagedEmbeddingClient(config, { storageDir: core.settings?.storageDir ?? '' })
      : null
    core.prepareEmbeddings = managed ? () => managed.prepare().catch(() => null) : null
    // Resume a previously installed managed runtime after a DSH restart without
    // ever starting a surprise download: only installed assets warm up eagerly.
    // Wait for the previous owner to finish closing so two starts cannot overlap.
    if (managed) {
      const owner = managed
      previousClose.then(() => resolveAssets(config, { storageDir: core.settings?.storageDir ?? '' }))
        .then(found => { if (found && managed === owner) return owner.prepare().catch(() => {}) })
        .catch(() => {})
    }
    const owner = managed
    rag = createRag(config, owner ? { client: { async embed(...args) { await previousClose; return owner.embed(...args) }, close: () => owner.close() } } : {})
    core.setRetrieval(rag); core.ragViews.clear()
  }
  core.restartRetrieval = restart
  core.embeddingSnapshot = () => managed?.snapshot() ?? { backend: embeddingBackend(core.rawConfig.rag), state: core.rawConfig.rag?.enabled ? 'external' : 'disabled', owned: false, autoManage: core.rawConfig.rag?.autoManage !== false }
  restart()
  core.components.retrieval = true
  ctx.effect(() => async () => {
    core.cancelModels('retrieval-disabled')
    rag.close()
    core.setRetrieval(null)
    core.ragViews.clear()
    core.components.retrieval = false
    if (core.restartRetrieval === restart) core.restartRetrieval = null
    core.prepareEmbeddings = null
    core.embeddingSnapshot = () => ({ state: 'disabled', owned: false })
    await Promise.allSettled([previousClose, managed?.close()])
  })
}
