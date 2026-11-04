import { createRag } from './rag.js'
export const inject = ['planCompletion']
export function apply(ctx) { return attach(ctx, ctx.get('planCompletion')) }
export function attach(ctx, core) {
  if (!core || core.components.retrieval) return
  const rag = createRag(core.rawConfig.rag)
  core.setRetrieval(rag)
  core.components.retrieval = true
  ctx.effect(() => () => {
    core.cancelModels('retrieval-disabled')
    rag.close()
    core.setRetrieval(null)
    core.ragViews.clear()
    core.components.retrieval = false
  })
}
