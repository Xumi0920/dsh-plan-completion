import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODEL_FILE,
  MODEL_URLS,
  OFFICIAL_Q8_SHA256,
  RUNTIME_ASSETS,
  detectProxy,
  extractZip,
  ensureManagedAssets,
  managedInstallDir,
  parseProxyServer,
  resolveAssets,
  runtimePlan,
} from '../host/rag-assets.js'

// Minimal store-only ZIP writer used to exercise the extractor without network.
function makeZip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const body = Buffer.from(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(Buffer.byteLength(name), 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10) // store
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(Buffer.byteLength(name), 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, Buffer.from(name), body)
    centrals.push(central, Buffer.from(name))
    offset += local.length + Buffer.byteLength(name) + body.length
  }
  const centralStart = offset
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

test('proxy detection supports env overrides and Windows ProxyServer syntax', () => {
  assert.equal(parseProxyServer('http=127.0.0.1:7897;https=127.0.0.1:7897'), 'http://127.0.0.1:7897')
  assert.equal(parseProxyServer('127.0.0.1:7897'), 'http://127.0.0.1:7897')
  assert.equal(parseProxyServer(''), '')
  assert.equal(detectProxy({ HTTPS_PROXY: 'http://proxy:8080' }, 'linux'), 'http://proxy:8080')
  assert.equal(detectProxy({ DSH_DOWNLOAD_PROXY: 'http://local:1', HTTPS_PROXY: 'http://env:2' }, 'linux'), 'http://local:1')
  assert.equal(detectProxy({}, 'linux'), '')
})

test('runtime assets are pinned for Windows and Linux x64, other platforms unsupported', () => {
  const win = runtimePlan('win32', 'x64'), linux = runtimePlan('linux', 'x64')
  assert.ok(win && linux)
  assert.equal(runtimePlan('darwin', 'arm64'), null)
  for (const plan of [win, linux]) {
    assert.ok(plan.variants.length >= 2)
    for (const variant of plan.variants) {
      assert.match(variant.sha256, /^[0-9a-f]{64}$/)
      assert.ok(variant.file.includes('llama'))
      assert.ok(variant.server === 'llama-server.exe' || variant.server === 'llama-server')
    }
  }
  assert.equal(MODEL_FILE, 'Qwen3-Embedding-0.6B-Q8_0.gguf')
  assert.equal(OFFICIAL_Q8_SHA256.length, 64)
  assert.ok(MODEL_URLS.some(url => url.includes('huggingface.co')))
  assert.equal(Object.keys(RUNTIME_ASSETS).length, 2)
})

test('managed install directory defaults to <storageDir>/managed and explicit installDir wins', () => {
  assert.equal(managedInstallDir({}, 'C:/data'), join('C:/data', 'managed'))
  assert.equal(managedInstallDir({ installDir: 'D:/assets' }, 'C:/data'), 'D:/assets')
  assert.equal(managedInstallDir({}, ''), '')
})

test('zip extraction writes files and rejects path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpc-zip-'))
  const zip = makeZip([{ name: 'bin/llama-server.exe', data: 'binary' }, { name: 'README.txt', data: 'hello' }])
  await extractZip(zip, join(root, 'out'))
  assert.equal(await readFile(join(root, 'out/bin/llama-server.exe'), 'utf8'), 'binary')
  assert.equal(await readFile(join(root, 'out/README.txt'), 'utf8'), 'hello')
  const traversal = makeZip([{ name: '../escape.txt', data: 'nope' }])
  await assert.rejects(async () => { await extractZip(traversal, join(root, 'out2')) }, /unsafe-archive-entry/)
})

test('resolveAssets precedence: config, environment, then managed marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpc-assets-'))
  const exe = join(root, 'llama-server.exe'), model = join(root, MODEL_FILE)
  await writeFile(exe, 'exe'); await writeFile(model, 'model')
  assert.equal((await resolveAssets({ executablePath: exe, modelPath: model }, {})).source, 'config')
  assert.equal((await resolveAssets({}, { env: { DSH_LLAMA_SERVER: exe, DSH_Q8_MODEL: model } })).source, 'env')
  const managedRoot = join(root, 'managed')
  await mkdir(managedRoot, { recursive: true })
  await writeFile(join(managedRoot, 'install.json'), JSON.stringify({ executablePath: exe, modelPath: model, modelSha256: OFFICIAL_Q8_SHA256 }))
  const managed = await resolveAssets({ installDir: managedRoot }, {})
  assert.equal(managed.source, 'managed')
  assert.equal(managed.managed, true)
  const empty = await mkdtemp(join(tmpdir(), 'dpc-empty-'))
  assert.equal(await resolveAssets({}, { storageDir: empty }), null)
})

test('ensureManagedAssets downloads pinned assets via injected deps and writes a verified marker', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'dpc-ensure-'))
  const calls = []
  const deps = {
    async downloadFile(urls, destination) {
      calls.push({ urls: urls[0], destination })
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(destination, 'asset-bytes')
      return 'sha'
    },
    async extractArchive(archive, destination) {
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, 'llama-server.exe'), 'exe')
    },
    async findServer(dir, name) { return join(dir, name) },
  }
  const resolved = await ensureManagedAssets({ autoManage: true }, { storageDir, platform: 'win32', arch: 'x64', deps })
  assert.equal(resolved.managed, true)
  assert.equal(resolved.source, 'downloaded')
  assert.ok(resolved.executablePath.endsWith('llama-server.exe'))
  assert.ok(resolved.modelPath.endsWith(MODEL_FILE))
  assert.ok(calls.some(call => call.urls.includes('llama.cpp')))
  assert.ok(calls.some(call => call.urls.includes('Qwen3-Embedding-0.6B-Q8_0.gguf')))
  const again = await ensureManagedAssets({}, { storageDir, platform: 'win32', arch: 'x64', deps })
  assert.equal(again.source, 'managed')
  const marker = JSON.parse(await readFile(join(storageDir, 'managed', 'install.json'), 'utf8'))
  assert.equal(marker.modelSha256, OFFICIAL_Q8_SHA256)
  assert.equal(marker.platform, 'win32-x64')
})

test('unsupported platforms fail closed without touching the install directory', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'dpc-unsupported-'))
  await assert.rejects(
    () => ensureManagedAssets({}, { storageDir, platform: 'darwin', arch: 'arm64' }),
    /unsupported-platform/,
  )
})
