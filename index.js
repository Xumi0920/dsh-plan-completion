/** One bundle: root state service plus independently managed Host components.
 * Keep the bare root row: DSH discovers the package's ./client through it. */
import { createCore } from './host/core.js'
import { attach as observer } from './host/observer.js'
import { attach as generator } from './host/generator.js'
import { attach as api } from './host/api.js'

export function apply(ctx, config = {}) {
  const core = createCore(ctx, config)
  ctx.provide('planCompletion', core)
  // Existing profile overrides replace an entire config object, so they can
  // omit the new marker. The loaded row inventory is authoritative even when
  // a component is disabled: otherwise legacy children would defeat its toggle.
  const entries = ctx.get('loader')?.entries?.() ?? []
  const managed = config.components === 'managed' || Array.from(entries).some(entry =>
    ['observer', 'generator', 'api'].some(name =>
      entry.options?.id === `plan-completion-${name}` && entry.options?.name === `dsh-plan-completion/${name}`))
  if (!managed) {
    generator(ctx, core)
    observer(ctx, core)
    api(ctx, core)
  }
  return core
}
