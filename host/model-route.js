import { randomUUID } from 'node:crypto'
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
 *
 * v0.1.6 model policy:
 *   default — follow the host's current default model (previous behaviour)
 *   fixed   — always use `fixedProvider`/`fixedModel` (only if resolvable)
 *   auto    — within the default provider, prefer a model without reasoning efforts
 * Without a host default route the generator falls back to heuristics (null).
 */
export async function pickModel(services, policy = null) {
  const llm = services.llm
  const selection = services.agentDefaultModel?.currentSelection?.()
  if (!llm) return null
  const mode = policy?.modelPolicy === 'fixed' ? 'fixed' : policy?.modelPolicy === 'auto' ? 'auto' : 'default'

  if (mode === 'fixed') {
    if (!policy?.fixedProvider || !policy?.fixedModel) return null
    const route = { provider: policy.fixedProvider, model: policy.fixedModel, source: 'fixed' }
    try {
      const info = await llm.resolveModelInfo?.(route.provider, route.model)
      if (info) {
        const efforts = info?.reasoning?.efforts
        if (Array.isArray(efforts) && efforts.length) route.reasoningEffort = efforts[0]?.id
        return route
      }
    } catch {
      /* A fixed route never authorizes another provider. */
    }
    return null
  }

  if (!selection?.provider || !selection?.model) return null

  if (mode === 'auto') {
    try {
      const models = typeof llm.listModels === 'function' ? await llm.listModels(selection.provider) : []
      for (const model of Array.isArray(models) ? models : []) {
        const id = String(model?.id ?? '')
        if (!id) continue
        try {
          const info = await llm.resolveModelInfo?.(selection.provider, id)
          const efforts = info?.reasoning?.efforts
          if (!Array.isArray(efforts) || efforts.length === 0) {
            return { provider: selection.provider, model: id, source: 'auto' }
          }
        } catch {
          /* try the next catalog entry */
        }
      }
    } catch {
      /* fall back to the host default */
    }
  }

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
export async function pickJudgeRoute(_services, mainRoute) {
  return mainRoute
}

export async function callModel(services, route, prompt, signal) {
  if (!services.llm || !route) throw new Error('no-llm-route')
  const messages = normalizePromptMessages(prompt)
  if (!messages.length) throw new Error('empty-messages')
  let text = ''
  let usage = null
  const request = {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages: messages.map(message => ({ ...message, id: 'message-' + randomUUID(), source: message.role === 'assistant' ? { kind: 'model', provider: route.provider, model: route.model } : { kind: 'user' } })),
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

