import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import http from 'node:http'
import { createEmbeddingClient } from './rag.js'
import { OFFICIAL_Q8_SHA256, assetsStatus, ensureManagedAssets } from './rag-assets.js'

export { LLAMA_RELEASE, MODEL_FILE, RUNTIME_ASSETS, runtimePlan } from './rag-assets.js'
export { OFFICIAL_Q8_SHA256 }
const int = (v, fallback, lo, hi) => Number.isInteger(v) ? Math.max(lo, Math.min(hi, v)) : fallback
export function embeddingBackend(config = {}) {
  if (config.backend === 'llama.cpp' || config.backend === 'external') return config.backend
  // Existing endpoint configurations retain their explicit destination until migrated.
  return config.endpoint ? 'external' : 'llama.cpp'
}
export function runtimeOptions(config = {}) {
  return {
    executablePath: typeof config.executablePath === 'string' ? config.executablePath.trim() : '',
    modelPath: typeof config.modelPath === 'string' ? config.modelPath.trim() : '',
    installDir: typeof config.installDir === 'string' ? config.installDir.trim() : '',
    autoManage: config.autoManage !== false,
    variant: config.variant === 'cpu' || config.variant === 'vulkan' ? config.variant : 'auto',
    startupTimeoutMs: int(config.startupTimeoutMs, 120000, 1000, 300000),
    idleTimeoutMs: int(config.idleTimeoutMs, 120000, 1000, 3600000),
    retryDelayMs: int(config.retryDelayMs, 3000, 100, 60000),
    contextSize: int(config.contextSize, 8192, 2048, 32768),
    gpuLayers: int(config.gpuLayers, 99, 0, 999),
    threads: int(config.threads, 4, 1, 64),
  }
}
export function runtimeEnvironment(env = process.env, versions = process.versions) {
  // Never inherit provider credentials, proxy routing or LLAMA_ARG_* overrides.
  const allowed = /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|CUDA_VISIBLE_DEVICES|VK_ICD_FILENAMES|VULKAN_SDK)$/i
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)))
  // Desktop Hosts use the Electron executable in Node mode; supervisors must too.
  if (versions.electron) result.ELECTRON_RUN_AS_NODE = '1'
  return result
}
async function validateFiles(options) {
  if (!isAbsolute(options.executablePath) || !isAbsolute(options.modelPath)) throw Error('paths-required')
  const [executablePath, modelPath] = await Promise.all([realpath(options.executablePath), realpath(options.modelPath)])
  const [exe, model] = await Promise.all([stat(executablePath), stat(modelPath)])
  if (!exe.isFile() || !model.isFile()) throw Error('invalid-files')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(modelPath)) hash.update(chunk)
  if (hash.digest('hex') !== OFFICIAL_Q8_SHA256) throw Error('not-official-q8')
  return { executablePath, modelPath }
}
async function resolveFiles(options, dependencies = {}) {
  // Test/caller injection keeps the original lazy-validation contract.
  if (dependencies.validateFiles) return dependencies.validateFiles(options)
  if (options.executablePath && options.modelPath) return validateFiles(options)
  if (!options.autoManage) throw Error('paths-required')
  const resolved = await ensureManagedAssets(options, {
    storageDir: dependencies.storageDir ?? '',
    env: dependencies.env,
    platform: dependencies.platform,
    arch: dependencies.arch,
    logger: dependencies.logger,
  })
  const [exe, model] = await Promise.all([stat(resolved.executablePath), stat(resolved.modelPath)])
  if (!exe.isFile() || !model.isFile()) throw Error('invalid-files')
  return resolved
}
async function freePort() {
  const server = net.createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) })
  })
}
function probe(port, key, alias, signal) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/v1/models', agent: false,
      headers: { Authorization: `Bearer ${key}` }, signal, timeout: 500 }, res => {
      let text = ''; res.on('data', b => { text += b; if (text.length > 8192) res.destroy() })
      res.on('error', () => resolve(false))
      res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(text).data.some(m => m.id === alias)) } catch { resolve(false) } })
    })
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false))
  })
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function cancellable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(Error('embedding-cancelled')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}

/**
 * One owner, one supervised llama-server. By default the runtime and the
 * official Q8 model are downloaded/verified on first use; explicit paths and
 * environment overrides remain available for advanced setups.
 */
export function createManagedEmbeddingClient(config = {}, dependencies = {}) {
  const options = runtimeOptions(config), now = dependencies.now ?? Date.now
  let worker = null, client = null, opening = null, closing = null, closed = false, state = 'stopped'
  let pid = null, port = null, error = null, starts = 0, retryAt = 0, active = 0, idle = null, startupController = null
  let files = null, managed = false, source = ''
  const spawnWorker = dependencies.spawn ?? spawn
  const snapshot = () => ({
    backend: 'llama.cpp', state, pid, port, starts, error,
    model: 'Qwen3-Embedding-0.6B-Q8_0', owned: true,
    managed, source, autoManage: options.autoManage, variant: options.variant,
    executablePath: files?.executablePath ?? '', modelPath: files?.modelPath ?? '',
    assets: managed ? assetsStatus() : null,
  })
  function armIdle() {
    if (!active && !closed && state === 'ready') { clearTimeout(idle); idle = setTimeout(() => { void stop() }, options.idleTimeoutMs); idle.unref?.() }
  }
  async function stop(final = false) {
    if (final) closed = true
    clearTimeout(idle); startupController?.abort(); client?.close(); client = null
    if (closing) return closing
    const current = worker
    if (!current) { state = closed ? 'closed' : 'stopped'; return }
    state = 'stopping'
    closing = new Promise(resolve => {
      let finished = false
      const done = () => { if (finished) return; finished = true; clearTimeout(timer); current.off('exit', done); if (worker === current) { worker = null; pid = null; port = null }; state = closed ? 'closed' : 'stopped'; resolve() }
      // The supervisor kills only its own child and exits after the child is reaped.
      const timer = setTimeout(() => { try { current.disconnect() } catch {} }, 5000)
      timer.unref?.(); current.once('exit', done)
      if (current.exitCode !== null && current.exitCode !== undefined) done()
      else { try { current.send({ type: 'stop' }, () => {}) } catch { try { current.disconnect() } catch {} } }
    })
    try { await closing } finally { closing = null }
  }
  async function attempt() {
    state = 'starting'; error = null
    const controller = new AbortController(); startupController = controller
    let deadline = null
    try {
      // Asset resolution/download intentionally sits outside the startup deadline:
      // the first managed download can take minutes and reports its own progress.
      const resolved = await resolveFiles(options, dependencies)
      files = resolved; managed = resolved.managed === true; source = resolved.source ?? ''
      if (closed || controller.signal.aborted) throw Error('startup-cancelled')
      port = await (dependencies.freePort ?? freePort)()
      if (closed || controller.signal.aborted) throw Error('startup-cancelled')
      deadline = setTimeout(() => controller.abort(), options.startupTimeoutMs)
      const key = randomBytes(32).toString('hex'), alias = 'dsh-q8-' + randomBytes(8).toString('hex')
      const current = spawnWorker(process.execPath, [fileURLToPath(new URL('./llama-worker.js', import.meta.url))],
        { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: runtimeEnvironment() })
      worker = current; starts++
      current.on('error', () => { error = 'worker-start-failed'; controller.abort() })
      current.on('message', message => {
        if (worker !== current) return
        if (message?.type === 'spawned') pid = message.pid
        if (message?.type === 'failed') { error = 'server-start-failed'; controller.abort() }
      })
      current.on('exit', () => {
        if (worker !== current) return
        worker = null; pid = null; port = null; client?.close(); client = null
        if (state !== 'stopping') { state = closed ? 'closed' : 'failed'; error = 'server-exited'; retryAt = now() + options.retryDelayMs }
        controller.abort()
      })
      current.send({ type: 'start', ...resolved, port, key, alias, options }, () => {})
      while (!closed && !controller.signal.aborted) {
        if (await (dependencies.probe ?? probe)(port, key, alias, controller.signal)) {
          if (worker !== current || closed || controller.signal.aborted) break
          client = (dependencies.createClient ?? createEmbeddingClient)({ ...config, endpoint: `http://127.0.0.1:${port}/v1/embeddings`, model: alias }, { apiKey: key })
          state = 'ready'; armIdle(); return client
        }
        await pause(100)
      }
      throw Error('startup-timeout')
    } finally {
      clearTimeout(deadline)
      if (startupController === controller) startupController = null
    }
  }
  async function open() {
    if (closed) throw Error('embedding-closed')
    if (client && state === 'ready') return client
    if (opening) return opening
    if (now() < retryAt) throw Error('embedding-cooling-down')
    opening = (async () => {
      if (closing) await closing
      let last = null
      // A Vulkan runtime that cannot start falls back once to the CPU build.
      const variants = options.variant === 'cpu' ? ['cpu'] : options.variant === 'vulkan' ? ['vulkan'] : ['auto', 'cpu']
      for (let index = 0; index < variants.length; index++) {
        options.variant = variants[index]
        try {
          return await attempt()
        } catch (e) {
          last = e
          await stop()
          if (closed) break
          const retryable = ['server-start-failed', 'server-exited', 'worker-start-failed', 'startup-timeout'].includes(error)
            || String(e?.message ?? '').includes('startup-timeout')
          if (!(options.autoManage && !dependencies.validateFiles && retryable)) break
        }
      }
      state = closed ? 'closed' : 'failed'
      const assetError = assetsStatus().error
      error = ['paths-required', 'invalid-files', 'not-official-q8', 'unsupported-platform'].includes(last?.message)
        ? last.message
        : assetError ? String(assetError) : error ?? 'startup-failed'
      retryAt = now() + options.retryDelayMs
      throw Error('local-embedding-unavailable')
    })()
    try { return await opening } finally { opening = null }
  }
  return {
    snapshot,
    async prepare() {
      // An explicit user retry must bypass the short failure cooldown.
      retryAt = 0
      await open()
      return snapshot()
    },
    async embed(texts, signal) {
      if (signal?.aborted) throw Error('embedding-cancelled')
      active++; clearTimeout(idle)
      try {
        const api = await cancellable(open(), signal)
        if (signal?.aborted || closed) throw Error('embedding-cancelled')
        return await api.embed(texts, signal)
      } finally {
        active--
        armIdle()
      }
    },
    close() { return stop(true) },
  }
}
