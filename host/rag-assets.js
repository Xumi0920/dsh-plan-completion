// host/rag-assets.js — zero-config managed Q8 assets.
//
// Resolves the llama.cpp runtime and the official Qwen3-Embedding-0.6B-Q8_0
// model without asking the user for paths:
//   1. explicit config paths (advanced mode)
//   2. DSH_LLAMA_SERVER / DSH_Q8_MODEL environment variables
//   3. a previously installed managed copy under `<storageDir>/managed`
//   4. automatic download of pinned, SHA-256-verified official assets
//
// Downloads are direct HTTPS (no proxy), redirects are followed manually,
// every byte is hashed and verified before an archive/model becomes usable.
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'

export const OFFICIAL_Q8_SHA256 = '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439'
export const MODEL_FILE = 'Qwen3-Embedding-0.6B-Q8_0.gguf'
export const MODEL_URLS = Object.freeze([
  'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/' + MODEL_FILE,
  'https://hf-mirror.com/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/' + MODEL_FILE,
])
export const LLAMA_RELEASE = 'b12128'
const RELEASE_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download/' + LLAMA_RELEASE

// Pinned official build assets (hashes computed from the published downloads).
export const RUNTIME_ASSETS = Object.freeze({
  'win32-x64': Object.freeze({
    archive: 'zip',
    variants: Object.freeze([
      Object.freeze({ name: 'vulkan', file: `llama-${LLAMA_RELEASE}-bin-win-vulkan-x64.zip`, sha256: '9cc33cbbb4c124a5694d6eec0bd0ecb69db291085ebe0a535a573484be2845ba', server: 'llama-server.exe', size: 37684327 }),
      Object.freeze({ name: 'cpu', file: `llama-${LLAMA_RELEASE}-bin-win-cpu-x64.zip`, sha256: '2864bc950fe1681f1867ebc1bf0d6a66d18cc5561b29c285b4504787145bd7b7', server: 'llama-server.exe', size: 24730477 }),
    ]),
  }),
  'linux-x64': Object.freeze({
    archive: 'tar.gz',
    variants: Object.freeze([
      Object.freeze({ name: 'vulkan', file: `llama-${LLAMA_RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`, sha256: '630d8e57080290005ec8df8126d324c7167ea4a4a8691919262a9ae7d0c5b210', server: 'llama-server', size: 35884041 }),
      Object.freeze({ name: 'cpu', file: `llama-${LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz`, sha256: 'a03e1f92e039dc23b630748db27f57f6287aa09a9d015c4eec6fc037657edf1e', server: 'llama-server', size: 23080410 }),
    ]),
  }),
})

export function runtimePlan(platform = process.platform, arch = process.arch) {
  return RUNTIME_ASSETS[`${platform}-${arch}`] ?? null
}

/** Managed install root: explicit `installDir`, else `<storageDir>/managed`. */
export function managedInstallDir(config = {}, storageDir = '') {
  const explicit = typeof config.installDir === 'string' ? config.installDir.trim() : ''
  if (explicit) return explicit
  return storageDir ? join(storageDir, 'managed') : ''
}

function variantsFor(plan, config = {}) {
  const wanted = config.variant === 'cpu' || config.variant === 'vulkan' ? config.variant : 'auto'
  if (wanted === 'auto') return plan.variants
  const chosen = plan.variants.filter(v => v.name === wanted)
  // Unknown/cpu-only preference still falls back to any available variant.
  return chosen.length ? chosen.concat(plan.variants.filter(v => v !== chosen[0])) : plan.variants
}

function safeJoin(root, name) {
  const target = resolve(root, name)
  if (target !== root && !target.startsWith(root + sep)) throw Error('unsafe-archive-entry')
  return target
}

/** Minimal ZIP reader (store/deflate) — official llama.cpp Windows archives. */
export function extractZip(buffer, destination) {
  mkdirSync(destination, { recursive: true })
  let eocd = -1
  const stop = Math.max(0, buffer.length - 66000)
  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw Error('bad-zip')
  const count = buffer.readUInt16LE(eocd + 10)
  const central = buffer.readUInt32LE(eocd + 16)
  let p = central
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw Error('bad-zip-central')
    const method = buffer.readUInt16LE(p + 10)
    const compressed = buffer.readUInt32LE(p + 20)
    const nameLength = buffer.readUInt16LE(p + 28)
    const extraLength = buffer.readUInt16LE(p + 30)
    const commentLength = buffer.readUInt16LE(p + 32)
    const local = buffer.readUInt32LE(p + 42)
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8')
    p += 46 + nameLength + extraLength + commentLength
    if (!name || name.endsWith('/')) continue
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) throw Error('unsafe-archive-entry')
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw Error('bad-zip-local')
    const localName = buffer.readUInt16LE(local + 26)
    const localExtra = buffer.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    if (start + compressed > buffer.length) throw Error('bad-zip-data')
    const raw = buffer.subarray(start, start + compressed)
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null
    if (!data) throw Error('unsupported-zip-method')
    const target = safeJoin(destination, name)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, data)
  }
}

function runTar(file, destination) {
  return new Promise((resolvePromise, reject) => {
    execFile('tar', ['-xzf', file, '-C', destination], { windowsHide: true }, error => error ? reject(error) : resolvePromise())
  })
}

export async function extractArchive(archivePath, destination, kind) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  if (kind === 'zip') extractZip(readFileSync(archivePath), destination)
  else if (kind === 'tar.gz') await runTar(archivePath, destination)
  else throw Error('unsupported-archive')
}

async function findServer(directory, name) {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === name) return path
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findServer(join(directory, entry.name), name)
    if (found) return found
  }
  return null
}

export async function hashFile(path) {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const assetStatus = {
  stage: 'idle', message: '', receivedBytes: 0, totalBytes: 0, percent: 0,
  runtimeVariant: '', installed: false, error: null,
}

export function assetsStatus() {
  return { ...assetStatus, managed: true }
}

function resetStatus() {
  Object.assign(assetStatus, { stage: 'idle', message: '', receivedBytes: 0, totalBytes: 0, percent: 0, runtimeVariant: '', installed: false, error: null })
}

function progress(stage, message, received = 0, total = 0) {
  Object.assign(assetStatus, {
    stage, message, receivedBytes: received, totalBytes: total,
    percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
  })
}

/** Parse a Windows ProxyServer value ("http=host:port;https=host:port" or "host:port"). */
export function parseProxyServer(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  const httpsMatch = text.match(/https=([^;]+)/i)
  const httpMatch = text.match(/http=([^;]+)/i)
  const candidate = (httpsMatch?.[1] || httpMatch?.[1] || text).split(';')[0].trim()
  if (!candidate) return ''
  return /^[a-z]+:\/\//i.test(candidate) ? candidate : 'http://' + candidate
}

/** Downloads may use an explicit/env proxy or the Windows system proxy; the llama
 *  child process itself never inherits proxy variables. */
export function detectProxy(env = process.env, platform = process.platform) {
  const direct = env.DSH_DOWNLOAD_PROXY || env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
  if (direct) return String(direct).trim()
  if (platform !== 'win32') return ''
  try {
    const output = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], {
      windowsHide: true, encoding: 'utf8', timeout: 3000,
    })
    const match = output.match(/ProxyServer\s+REG_SZ\s+(.+)/)
    return match ? parseProxyServer(match[1]) : ''
  } catch { return '' }
}

function proxyAuthorization(proxyUrl) {
  try {
    const proxy = new URL(proxyUrl)
    if (!proxy.username) return ''
    const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64')
    return `Proxy-Authorization: Basic ${token}\r\n`
  } catch { return '' }
}

function requestViaProxy(targetUrl, proxyUrl, signal) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(targetUrl)
    if (target.protocol !== 'https:') { reject(Error('proxy-http-unsupported')); return }
    let proxy
    try { proxy = new URL(proxyUrl) } catch { reject(Error('bad-proxy')); return }
    const socket = net.connect(Number(proxy.port) || 80, proxy.hostname)
    let settled = false, secure = null, proxyBuffer = Buffer.alloc(0)
    const fail = error => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      try { secure?.destroy() } catch {}
      reject(error instanceof Error ? error : Error(String(error)))
    }
    socket.setTimeout(30000, () => fail(Error('proxy-timeout')))
    socket.on('error', fail)
    socket.once('connect', () => {
      socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${proxyAuthorization(proxyUrl)}\r\n`)
    })
    const onProxyData = chunk => {
      proxyBuffer = Buffer.concat([proxyBuffer, chunk])
      const end = proxyBuffer.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.removeListener('data', onProxyData)
      const status = proxyBuffer.subarray(0, end).toString('latin1').split('\r\n')[0] || ''
      if (!/ 200 /.test(status)) { fail(Error('proxy-connect-' + (status.split(' ')[1] || 'failed'))); return }
      socket.setTimeout(0)
      secure = tls.connect({ socket, servername: target.hostname })
      secure.setTimeout(30000, () => fail(Error('download-timeout')))
      secure.on('error', fail)
      let headerBuffer = Buffer.alloc(0), responseReady = false
      const onSecureData = chunk => {
        if (responseReady) return
        headerBuffer = Buffer.concat([headerBuffer, chunk])
        const headerEnd = headerBuffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        responseReady = true
        secure.removeListener('data', onSecureData)
        settled = true
        const lines = headerBuffer.subarray(0, headerEnd).toString('latin1').split('\r\n')
        const statusCode = Number((lines.shift() || '').split(' ')[1]) || 0
        const headers = {}
        for (const line of lines) {
          const colon = line.indexOf(':')
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        const leftover = headerBuffer.subarray(headerEnd + 4)
        const response = new Readable({ read() {} })
        response.statusCode = statusCode
        response.headers = headers
        if (leftover.length) response.push(leftover)
        secure.on('data', data => { if (!response.push(data)) secure.pause() })
        secure.on('end', () => response.push(null))
        secure.on('close', () => response.push(null))
        secure.setTimeout(0)
        resolvePromise(response)
      }
      secure.on('data', onSecureData)
      secure.once('secureConnect', () => {
        secure.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: dsh-plan-completion/q8-setup\r\nAccept: */*\r\nConnection: close\r\n\r\n`)
      })
    }
    socket.on('data', onProxyData)
  })
}

function requestUrl(url, signal) {
  return new Promise((resolvePromise, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.get(parsed, {
      agent: false,
      signal,
      headers: { 'user-agent': 'dsh-plan-completion/q8-setup' },
    }, resolvePromise)
    req.setTimeout(30000, () => req.destroy(Error('download-timeout')))
    req.on('error', reject)
  })
}

let curlProbe
/** curl is the most reliable cross-platform way to honor an HTTP proxy. */
function hasCurl() {
  if (curlProbe !== undefined) return curlProbe
  try {
    execFileSync('curl', ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 3000 })
    curlProbe = true
  } catch { curlProbe = false }
  return curlProbe
}

async function downloadViaCurl(url, destination, options) {
  const { sha256, expectedBytes = 0, proxy } = options
  const temporary = destination + '.part'
  await rm(temporary, { force: true })
  const args = ['--location', '--fail', '--silent', '--show-error', '--connect-timeout', '30', '--output', temporary]
  if (proxy) args.push('--proxy', proxy)
  args.push(url)
  return new Promise((resolvePromise, reject) => {
    let done = false
    const finish = async (error) => {
      if (done) return
      done = true
      clearInterval(timer)
      if (error) { await rm(temporary, { force: true }); reject(error); return }
      try {
        const digest = await hashFile(temporary)
        if (digest !== sha256) throw Error('asset-hash-mismatch')
        await rename(temporary, destination)
        resolvePromise(digest)
      } catch (verifyError) {
        await rm(temporary, { force: true })
        reject(verifyError)
      }
    }
    const child = execFile('curl', args, { windowsHide: true, timeout: 600000, maxBuffer: 1 << 20 }, error => { void finish(error) })
    child.on('error', error => { void finish(error) })
    const timer = setInterval(() => {
      stat(temporary).then(info => progress('downloading', '', info.size, expectedBytes)).catch(() => {})
    }, 500)
  })
}

async function downloadOne(url, destination, options) {
  const { sha256, expectedBytes = 0, signal, onProgress } = options
  const temporary = destination + '.part'
  await rm(temporary, { force: true })
  progress('downloading', '', 0, expectedBytes)
  const proxy = detectProxy()
  if (proxy) {
    // Direct Node HTTPS is often blocked when the desktop requires a proxy;
    // curl gives a reliable, cross-platform proxy transport for pinned assets.
    if (!hasCurl()) throw Error('proxy-download-requires-curl')
    return downloadViaCurl(url, destination, { sha256, expectedBytes, proxy })
  }
  const response = await requestUrl(url, signal)
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    const next = new URL(response.headers.location, url).toString()
    response.resume()
    if (options.redirects >= 5) throw Error('too-many-redirects')
    return downloadOne(next, destination, { ...options, redirects: (options.redirects ?? 0) + 1 })
  }
  if (response.statusCode !== 200) { response.resume(); throw Error('download-http-' + response.statusCode) }
  const total = Number(response.headers['content-length']) || expectedBytes
  const hash = createHash('sha256')
  const output = createWriteStream(temporary)
  let received = 0
  try {
    for await (const chunk of response) {
      if (signal?.aborted) throw Error('download-cancelled')
      hash.update(chunk)
      received += chunk.length
      if (!output.write(chunk)) await new Promise(r => output.once('drain', r))
      onProgress?.({ received, total })
      progress('downloading', '', received, total)
    }
    await new Promise((resolvePromise, reject) => output.end(error => error ? reject(error) : resolvePromise()))
  } catch (error) {
    output.destroy()
    await rm(temporary, { force: true })
    throw error
  }
  const digest = hash.digest('hex')
  if (digest !== sha256) { await rm(temporary, { force: true }); throw Error('asset-hash-mismatch') }
  await rename(temporary, destination)
  return digest
}

/** Try each URL in order; verify SHA-256; atomic rename. */
export async function downloadFile(urls, destination, options) {
  await mkdir(resolve(destination, '..'), { recursive: true })
  let last
  for (const url of urls) {
    try {
      if (existsSync(destination) && await hashFile(destination) === options.sha256) return destination
      return await downloadOne(url, destination, { ...options, redirects: 0 })
    } catch (error) { last = error }
  }
  throw last ?? Error('download-failed')
}

function readMarker(root) {
  try {
    const marker = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))
    if (!marker || typeof marker !== 'object') return null
    if (!marker.executablePath || !marker.modelPath) return null
    if (!existsSync(marker.executablePath) || !existsSync(marker.modelPath)) return null
    return marker
  } catch { return null }
}

/** Resolve an existing non-managed or already-installed managed copy, if any. */
export async function resolveAssets(config = {}, context = {}) {
  const env = context.env ?? process.env
  const explicitExe = typeof config.executablePath === 'string' ? config.executablePath.trim() : ''
  const explicitModel = typeof config.modelPath === 'string' ? config.modelPath.trim() : ''
  if (explicitExe && explicitModel) return { managed: false, source: 'config', executablePath: explicitExe, modelPath: explicitModel }
  const envExe = typeof env.DSH_LLAMA_SERVER === 'string' ? env.DSH_LLAMA_SERVER.trim() : ''
  const envModel = typeof env.DSH_Q8_MODEL === 'string' ? env.DSH_Q8_MODEL.trim() : ''
  if (envExe && envModel && existsSync(envExe) && existsSync(envModel)) {
    return { managed: false, source: 'env', executablePath: envExe, modelPath: envModel }
  }
  const root = managedInstallDir(config, context.storageDir ?? '')
  const marker = root ? readMarker(root) : null
  if (marker) return { managed: true, source: 'managed', installDir: root, ...marker }
  return null
}

/**
 * Ensure the managed runtime + official model exist, downloading pinned assets
 * on first use. `context.deps` may override network/extract/hash for tests.
 */
export async function ensureManagedAssets(config = {}, context = {}) {
  const requestedVariant = config.variant === 'cpu' || config.variant === 'vulkan' ? config.variant : 'auto'
  const existing = await resolveAssets(config, context)
  if (existing) {
    // An explicit variant switch (e.g. auto -> cpu after a GPU startup failure)
    // must actually reinstall instead of reusing the previous variant.
    const variantMismatch = existing.managed === true && requestedVariant !== 'auto'
      && existing.variant && existing.variant !== requestedVariant
    if (!variantMismatch) { assetStatus.installed = existing.managed === true; return existing }
  }
  const root = managedInstallDir(config, context.storageDir ?? '')
  if (!root) throw Error('storage-required')
  const plan = runtimePlan(context.platform ?? process.platform, context.arch ?? process.arch)
  if (!plan) throw Error('unsupported-platform')
  const deps = context.deps ?? {}
  const platformKey = `${context.platform ?? process.platform}-${context.arch ?? process.arch}`
  resetStatus()
  assetStatus.installed = false
  try {
    let runtime = null
    for (const variant of variantsFor(plan, config)) {
      const archivePath = join(root, 'downloads', variant.file)
      const runtimeDir = join(root, 'runtime', `${LLAMA_RELEASE}-${platformKey}-${variant.name}`)
      try {
        progress('runtime', `下载 llama.cpp 运行时（${variant.name}）`)
        await (deps.downloadFile ?? downloadFile)([`${RELEASE_BASE}/${variant.file}`], archivePath, { sha256: variant.sha256, expectedBytes: variant.size, signal: context.signal })
        progress('extracting', `解压 llama.cpp 运行时（${variant.name}）`)
        await (deps.extractArchive ?? extractArchive)(archivePath, runtimeDir, plan.archive)
        const executablePath = await (deps.findServer ?? findServer)(runtimeDir, variant.server)
        if (!executablePath) throw Error('runtime-server-missing')
        runtime = { executablePath, variant: variant.name, runtimeDir }
        break
      } catch (error) {
        assetStatus.error = String(error?.message ?? error)
        runtime = null
      }
    }
    if (!runtime) throw Error(assetStatus.error ?? 'runtime-download-failed')
    const modelPath = join(root, 'models', MODEL_FILE)
    progress('model', '下载官方 Qwen3-Embedding-0.6B Q8 模型（约 610MB）')
    await (deps.downloadFile ?? downloadFile)(MODEL_URLS, modelPath, { sha256: OFFICIAL_Q8_SHA256, signal: context.signal })
    const marker = {
      release: LLAMA_RELEASE, platform: platformKey, variant: runtime.variant,
      executablePath: runtime.executablePath, modelPath,
      modelSha256: OFFICIAL_Q8_SHA256, installedAt: new Date().toISOString(),
    }
    await writeFile(join(root, 'install.json'), JSON.stringify(marker, null, 2) + '\n', 'utf8')
    Object.assign(assetStatus, { stage: 'ready', message: '本地 Q8 就绪', percent: 100, runtimeVariant: runtime.variant, installed: true, error: null })
    return { managed: true, source: 'downloaded', installDir: root, ...marker }
  } catch (error) {
    Object.assign(assetStatus, { stage: 'failed', error: String(error?.message ?? error), percent: 0, installed: false })
    throw error
  }
}
