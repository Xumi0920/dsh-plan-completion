import { createManagedEmbeddingClient, embeddingBackend } from './embedding-runtime.js'
import { resolveAssets } from './rag-assets.js'

export const inject = ['planCompletion']
export function apply(ctx) { return attach(ctx, ctx.get('planCompletion')) }

/** Own the local Q8 process; retrieval only borrows its embedding client. */
export function attach(ctx, core, dependencies = {}) {
  if (!core || core.components.embedding) return
  const createClient = dependencies.createClient ?? createManagedEmbeddingClient
  const findAssets = dependencies.resolveAssets ?? resolveAssets
  let managed = null, disposed = false
  core.components.embedding = true
  function restart() {
    if (disposed || core.disposed) return
    core.cancelModels('embedding-reconfigured')
    const previous = managed
    const closing = Promise.allSettled([core.embeddingClosing, previous?.close()])
    core.embeddingClosing = closing
    const config = core.rawConfig.rag ?? {}
    managed = config.enabled && embeddingBackend(config) === 'llama.cpp'
      ? createClient(config, { storageDir: core.settings?.storageDir ?? '' }) : null
    const owner = managed
    core.embeddingClient = owner ? {
      async embed(...args) {
        await closing
        if (disposed || managed !== owner) throw new Error('embedding-unavailable')
        return owner.embed(...args)
      },
    } : null
    core.prepareEmbeddings = owner ? async () => {
      await closing
      if (disposed || managed !== owner) return null
      return owner.prepare().catch(() => null)
    } : null
    // Only installed assets warm automatically; downloads still use explicit setup.
    if (owner) closing.then(() => findAssets(config, { storageDir: core.settings?.storageDir ?? '' }))
      .then(found => { if (found && !disposed && managed === owner) return owner.prepare() }).catch(() => {})
    core.restartRetrieval?.()
  }
  core.restartEmbedding = restart
  const inactive = () => ({ backend: embeddingBackend(core.rawConfig.rag),
    state: core.rawConfig.rag?.enabled && embeddingBackend(core.rawConfig.rag) === 'external' ? 'external' : 'disabled', owned: false })
  core.embeddingSnapshot = () => managed?.snapshot() ?? inactive()
  restart()
  ctx.effect(() => async () => {
    disposed = true
    core.cancelModels('embedding-disabled')
    core.components.embedding = false
    core.embeddingClient = null
    core.prepareEmbeddings = null
    if (core.restartEmbedding === restart) core.restartEmbedding = null
    core.embeddingSnapshot = inactive
    core.embeddingClosing = Promise.allSettled([core.embeddingClosing, managed?.close()])
    core.restartRetrieval?.()
    await core.embeddingClosing
  })
}
