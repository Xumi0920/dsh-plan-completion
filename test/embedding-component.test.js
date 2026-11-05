import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { attach as embedding } from '../host/embedding.js'
import { attach as retrieval, apply as applyRetrieval } from '../host/retrieval.js'
import { createHostFixture, deferred, flushJobs } from '../support/host-fixture.js'

function mount(h, fn) {
  const cleanups = []
  fn({ get: h.ctx.get, effect: f => { const stop = f(); if (stop) cleanups.push(stop) } }, h.core)
  return async () => { for (const stop of cleanups.splice(0).reverse()) await stop() }
}
function setup(t, close) {
  const h = createHostFixture(apply, [], { components: 'managed', persistPlans: false, modelCalls: false, rag: { enabled: true, backend: 'llama.cpp' } })
  const clients = [], stops = []
  const deps = { resolveAssets: async () => null, createClient() {
    const client = { prepares: 0, closes: 0,
      async prepare() { client.prepares++ },
      async embed(texts) { return texts.map(() => new Float32Array(1024)) },
      snapshot() { return { state: 'ready', owned: true } },
      async close() { client.closes++; await close?.() },
    }; clients.push(client); return client
  } }
  t.after(async () => { for (const stop of stops.reverse()) await stop(); h.dispose() })
  return { h, clients, startEmbedding() { const stop = mount(h, (ctx, core) => embedding(ctx, core, deps)); stops.push(stop); return stop },
    startRetrieval() { const stop = mount(h, retrieval); stops.push(stop); return stop } }
}

test('retrieval does not own Q8: stopping or restarting the index keeps its process alive', async t => {
  const f = setup(t); f.startEmbedding(); const stopRetrieval = f.startRetrieval()
  await f.h.core.prepareEmbeddings()
  f.h.core.restartRetrieval(); await stopRetrieval()
  assert.equal(f.clients[0].closes, 0)
  assert.equal(f.h.core.components.embedding, true)
  assert.equal(f.h.core.components.retrieval, false)
  assert.equal(f.h.core.embeddingSnapshot().state, 'ready')
});

test('stopping Q8 leaves retrieval available for lexical queries and preserves plans', async t => {
  const f = setup(t); const stopEmbedding = f.startEmbedding(); f.startRetrieval()
  const plan = { marker: 'preserved' }; f.h.core.states.set('s', { plan })
  await stopEmbedding()
  assert.equal(f.clients[0].closes, 1)
  assert.equal(f.h.core.embeddingClient, null)
  assert.equal(f.h.core.prepareEmbeddings, null)
  assert.equal(f.h.core.components.retrieval, true)
  assert.equal(f.h.state('s').plan, plan)
  f.h.core.rag.sync('s', [{type: 'user/message', seq: 1, data: {role: 'user', content: [{type: 'text', text: 'release validation checklist'}]}}])
  const result = await f.h.core.rag.retrieve('s', 'release validation')
  assert.equal(result.mode, 'lexical'); assert.ok(result.records.length)
  f.startEmbedding(); await f.h.core.prepareEmbeddings()
  assert.equal(f.h.core.components.embedding, true); assert.equal(f.clients[1].prepares, 1)
});

test('a replacement Q8 owner waits for the previous process to close', async t => {
  const done = deferred(); const f = setup(t, () => done.promise)
  const stop = f.startEmbedding(); const closing = stop()
  f.startEmbedding(); const preparing = f.h.core.prepareEmbeddings()
  await flushJobs(); assert.equal(f.clients[1].prepares, 0)
  done.resolve(); await closing; await preparing
  assert.equal(f.clients[1].prepares, 1)
});

test('settings reconfigure Q8 and reject calls against its old owner', async t => {
  const f = setup(t); f.startEmbedding(); f.startRetrieval()
  const old = f.h.core.embeddingClient
  f.h.core.rawConfig.rag.enabled = false; f.h.core.restartEmbedding(); await flushJobs()
  assert.equal(f.clients[0].closes, 1); assert.equal(f.h.core.rag.settings.enabled, false)
  await assert.rejects(old.embed(['late']), /unavailable/)
});

for (const disabledRow of [false, true]) test(`old five-row migration respects explicit Q8 row: ${disabledRow}`, t => {
  const h = createHostFixture(apply, [], {components: 'managed', persistPlans: false, rag: {enabled: false}})
  t.after(() => h.dispose())
  const get = h.ctx.get
  const ctx = { get: name => name === 'loader' ? {entries: () => disabledRow ? [{options: {name: 'dsh-plan-completion/embedding', disabled: true}}] : []} : get(name), effect: h.ctx.effect }
  applyRetrieval(ctx)
  assert.equal(h.core.components.embedding, !disabledRow); assert.equal(h.core.components.retrieval, true)
});

test('root-only profiles still mount all six responsibilities', t => {
  const h = createHostFixture(apply, [], {persistPlans: false, modelCalls: false}); t.after(() => h.dispose())
  assert.deepEqual(Object.keys(h.core.components).sort(), ['api', 'core', 'embedding', 'generator', 'observer', 'retrieval'])
  assert.ok(Object.values(h.core.components).every(Boolean))
});
