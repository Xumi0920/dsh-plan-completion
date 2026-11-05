import { createRag } from './rag.js'
import { embeddingBackend } from './embedding-runtime.js'
import { attach as attachEmbedding } from './embedding.js'
export const inject = ['planCompletion']
export function apply(ctx) {
  const core = ctx.get('planCompletion')
  // Old five-row profiles own Q8 through retrieval. An explicitly disabled new
  // embedding row must never be revived by this compatibility path.
  const entries = Array.from(ctx.get('loader')?.entries?.() ?? [])
  const managedEmbedding = entries.some(entry => entry.options?.name === 'dsh-plan-completion/embedding')
  if (!managedEmbedding) attachEmbedding(ctx, core)
  return attach(ctx, core)
}
export function attach(ctx, core) {
  if (!core || core.components.retrieval) return
  let rag, disposed = false
  function restart() {
    if (disposed || core.disposed) return
    core.cancelModels('retrieval-reconfigured')
    rag?.close()
    const config = core.rawConfig.rag ?? {}
    // No local runtime means lexical retrieval, never an implicit external endpoint.
    const client = embeddingBackend(config) === 'llama.cpp' ? {
      async embed(...args) {
        if (!core.embeddingClient) throw new Error('embedding-unavailable')
        return core.embeddingClient.embed(...args)
      },
      close() {}, // Borrowed: only the embedding component may stop its process.
    } : null
    rag = createRag(config, client ? { client } : {})
    core.setRetrieval(rag); core.ragViews.clear()
  }
  core.restartRetrieval = restart
  restart()
  core.components.retrieval = true
  ctx.effect(() => () => {
    disposed = true
    core.cancelModels('retrieval-disabled')
    rag.close()
    core.setRetrieval(null)
    core.ragViews.clear()
    core.components.retrieval = false
    if (core.restartRetrieval === restart) core.restartRetrieval = null
  })
}
