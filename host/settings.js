import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
/**
 * Resolve the local plan-store directory. `~` is expanded so a shipped config can point at the
 * user's home without hard-coding an absolute path. Empty means "memory only".
 */
export function expandStorageDir(value, envValue, dshHome = process.env.DSH_HOME) {
  const raw = typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : (typeof envValue === 'string' ? envValue.trim() : '')
  if (raw === '') return ''
  // The shipped default follows DSH's isolated home; explicit directories keep
  // their original meaning. Never import another profile's plans implicitly.
  if (raw.replaceAll('\\', '/') === '~/.dsh/plan-completion-data' && typeof dshHome === 'string' && dshHome.trim()) {
    return join(resolve(dshHome.trim()), 'plan-completion-data')
  }
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    try {
      return raw === '~' ? homedir() : join(homedir(), raw.slice(2))
    } catch {
      return ''
    }
  }
  return raw
}

const MODEL_POLICIES = new Set(['default', 'fixed', 'auto'])

export function normalizeModelPolicy(value) {
  const policy = typeof value === 'string' ? value.trim() : ''
  return MODEL_POLICIES.has(policy) ? policy : 'default'
}

/** Settings written through the model-settings page (persisted next to the plan store). */
export function readSavedSettings(dir) {
  if (!dir) return {}
  try {
    const data = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

export function writeSavedSettings(dir, data) {
  if (!dir) return false
  try {
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'settings.json')
    const tmp = join(dir, `.settings-${process.pid}-${Date.now()}.json.tmp`)
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

