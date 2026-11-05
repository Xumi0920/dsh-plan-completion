// Dedicated supervisor. IPC disconnect also reaps llama-server after a Host crash.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
let child = null, directory = null, keyFile = null, logStream = null, stopping = false, started = false
let tail = '', logBytes = 0
const LOG_LIMIT = 2 * 1024 * 1024
const send = message => { if (process.connected) process.send(message, () => {}) }
function appendTail(chunk) {
  tail = (tail + chunk.toString()).slice(-8192)
}
function writeLog(data) {
  if (!logStream || logBytes >= LOG_LIMIT) return
  logBytes += data.length
  try { logStream.write(data) } catch {}
}
async function cleanup() {
  try { logStream?.end() } catch {}
  if (keyFile) await unlink(keyFile).catch(() => {})
  if (directory) await rmdir(directory).catch(() => {})
}
async function stop() {
  if (stopping) return
  stopping = true
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      child.once('exit', resolve)
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 1500)
      child.once('exit', () => clearTimeout(timer)); child.kill()
    })
  }
  await cleanup(); process.exit(0)
}
function fail(message) {
  send({ type: 'failed', tail: tail.slice(-4096), message: message ?? '' })
  void stop()
}
process.on('disconnect', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
process.on('message', async message => {
  if (message?.type === 'stop') { void stop(); return }
  if (message?.type === 'tail') { send({ type: 'tail', tail: tail.slice(-4096) }); return }
  if (message?.type !== 'start' || started || stopping) return
  started = true
  try {
    directory = mkdtempSync(join(tmpdir(), 'dsh-q8-'))
    keyFile = join(directory, 'api-key')
    writeFileSync(keyFile, message.key + '\n', { mode: 0o600 })
    if (stopping || !process.connected) { await cleanup(); return }
    const logPath = typeof message.logPath === 'string' && message.logPath ? message.logPath : ''
    if (logPath) {
      try { mkdirSync(dirname(logPath), { recursive: true }); logStream = createWriteStream(logPath, { flags: 'w' }) } catch { logStream = null }
    }
    const o = message.options
    child = spawn(message.executablePath, ['--model', message.modelPath, '--host', '127.0.0.1', '--port', String(message.port),
      '--alias', message.alias, '--embedding', '--pooling', 'last', '--ctx-size', String(o.contextSize),
      '--batch-size', String(o.contextSize), '--ubatch-size', String(o.contextSize), '--parallel', '1',
      '--gpu-layers', String(o.gpuLayers), '--threads', String(o.threads), '--api-key-file', keyFile, '--no-webui'],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    const forward = data => { appendTail(data); writeLog(data) }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.once('error', error => fail('spawn-error: ' + String(error?.message ?? error)))
    child.once('spawn', () => send({ type: 'spawned', pid: child.pid, logPath }))
    child.once('exit', (code, signal) => { if (!stopping) fail('server-exit code=' + code + ' signal=' + signal) })
  } catch (error) { fail('worker-error: ' + String(error?.message ?? error)) }
})
