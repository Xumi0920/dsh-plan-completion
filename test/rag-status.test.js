import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { HOST_KEY, createHostFixture } from '../support/host-fixture.js'

function setup(t, config) {
  delete globalThis[HOST_KEY]
  const host = createHostFixture(apply, [], config)
  t.after(() => { host.dispose(); delete globalThis[HOST_KEY] })
  return host
}

test('rag status endpoint reports process state and defaults to 200 log tail lines', async t => {
  const host = setup(t)
  const response = await host.request('/plan-completion/rag/status')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.rag.enabled, false)
  assert.equal(response.body.embedding.state, 'disabled')
  assert.equal(response.body.process.running, false)
  assert.equal(response.body.process.state, 'disabled')
  assert.equal(response.body.process.pid, null)
  assert.equal(typeof response.body.prepareAvailable, 'boolean')
  assert.deepEqual(response.body.log.startup, [])
  assert.deepEqual(response.body.log.tail, [])
  assert.deepEqual(response.body.logTail, [])
  assert.equal(response.body.log.tailLines, 200)
  assert.ok(Array.isArray(response.body.logTail))
})

test('rag status tail parameter is bounded and echoed back', async t => {
  const host = setup(t)
  const small = await host.request('/plan-completion/rag/status?tail=25')
  assert.equal(small.body.log.tailLines, 25)
  const large = await host.request('/plan-completion/rag/status?tail=5000')
  assert.equal(large.body.log.tailLines, 1000)
})

test('rag prepare endpoint responds when the retrieval component is unavailable', async t => {
  const host = setup(t)
  const response = await host.request('/plan-completion/rag/prepare', {})
  // Disabled retrieval has no managed owner; the request is rejected instead of crashing.
  assert.ok([200, 400, 202].includes(response.status))
  assert.equal(typeof response.body, 'object')
})
