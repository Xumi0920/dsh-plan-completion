// Dedicated supervisor. IPC disconnect also reaps llama-server after a Host crash.
import { spawn } from 'node:child_process'
import { unlink, rmdir } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let child = null, directory = null, keyFile = null, stopping = false, started = false
const send = message => { if (process.connected) process.send(message, () => {}) }
async function cleanup() {
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
process.on('disconnect', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
process.on('message', async message => {
  if (message?.type === 'stop') { void stop(); return }
  if (message?.type !== 'start' || started || stopping) return
  started = true
  try {
    directory = mkdtempSync(join(tmpdir(), 'dsh-q8-'))
    keyFile = join(directory, 'api-key')
    writeFileSync(keyFile, message.key + '\n', { mode: 0o600 })
    if (stopping || !process.connected) { await cleanup(); return }
    const o = message.options
    child = spawn(message.executablePath, ['--model', message.modelPath, '--host', '127.0.0.1', '--port', String(message.port),
      '--alias', message.alias, '--embedding', '--pooling', 'last', '--ctx-size', String(o.contextSize),
      '--batch-size', String(o.contextSize), '--ubatch-size', String(o.contextSize), '--parallel', '1',
      '--gpu-layers', String(o.gpuLayers), '--threads', String(o.threads), '--api-key-file', keyFile, '--no-webui', '--log-disable'],
    { shell: false, windowsHide: true, stdio: 'ignore', env: process.env })
    child.once('error', () => { send({ type: 'failed' }); void stop() })
    child.once('spawn', () => send({ type: 'spawned', pid: child.pid }))
    child.once('exit', () => { if (!stopping) { send({ type: 'failed' }); void stop() } })
  } catch { send({ type: 'failed' }); await stop() }
})
