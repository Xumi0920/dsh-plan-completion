// Optional native Loader check: node scripts/check-components-dsh.mjs <DSH runtime directory>
// Uses an isolated temporary DSH_HOME, no model calls and no Q8 downloads.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.ok(process.argv[2], 'Pass a DSH runtime directory containing node_modules/@deepseek-ai')
const runtime = resolve(process.argv[2])
const plugin = fileURLToPath(new URL('..', import.meta.url))
const { boot, loadOptionalPatches, composeEntries, readPluginMeta } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await sleep(20) }
  assert.ok(check(), 'Loader state did not converge')
}
for (const mode of ['six-rows', 'old-five-rows', 'root-only']) {
  const home = await mkdtemp(join(tmpdir(), 'dpc-components-'))
  await mkdir(join(home, 'node_modules'))
  await symlink(join(runtime, 'node_modules/@deepseek-ai'), join(home, 'node_modules/@deepseek-ai'), 'junction')
  await symlink(plugin, join(home, 'node_modules/dsh-plan-completion'), 'junction')
  await writeFile(join(home, 'cordis.yml'), '[]\n')
  await writeFile(join(home, 'package.json'), '{"name":"isolated-component-check","private":true}')
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const base = ['dsh-base', 'dsh-web-app'].flatMap(name => loadOptionalPatches('component-check', join(runtime, 'node_modules/@deepseek-ai', name, 'cordis.patch.yml')))
  const patches = [...base]
  for (const row of composeEntries([base])) if (row.id.startsWith('tool-') || ['deepseek-account', 'llm-deepseek-account', 'llm-deepseek', 'llm-pi-ai', 'session-title-llm', 'desktop-product-telemetry', 'product-analytics'].includes(row.id)) patches.push({id: row.id, disabled: true})
  const bundle = loadOptionalPatches('component-check', join(plugin, 'cordis.patch.yml')).map(patch => ({...patch,
    insert: patch.insert?.filter(row => mode === 'root-only' ? row.id === 'plan-completion' : mode === 'old-five-rows' ? row.id !== 'plan-completion-embedding' : true)}))
  patches.push(...bundle, {id: 'web-runtime', config: {openBrowser: false, printUrl: false}},
    {id: 'plan-completion', config: {modelCalls: false, persistPlans: false, warmBackfill: false, storageDir: join(home, 'plan-data'), rag: {enabled: false}}})
  const anchor = pathToFileURL(join(home, 'package.json')).href
  const ctx = await boot('component-check', join(home, 'cordis.yml'), patches,
    c => c.provide('webStartup', {host: '127.0.0.1', port: 0, openBrowser: false, trustedHosts: []}), anchor)
  try {
    await waitFor(() => ctx.get('planCompletion')?.components.api)
    const core = ctx.get('planCompletion')
    await waitFor(() => Object.values(core.components).every(Boolean))
    const rows = [...ctx.loader.entries()].filter(e => e.options.id.startsWith('plan-completion'))
    assert.equal(rows.length, mode === 'six-rows' ? 6 : mode === 'old-five-rows' ? 5 : 1)
    for (const row of rows) {
      assert.equal(row.fiber.state, 2)
      const meta = readPluginMeta(row.options.name, anchor)
      assert.ok(!meta?.error, meta?.error)
      for (const lang of ['zh', 'en']) { assert.ok(meta.title[lang]); assert.ok(meta.description[lang]) }
    }
    if (mode === 'six-rows') {
      const q8 = rows.find(r => r.options.id === 'plan-completion-embedding')
      const retrieval = rows.find(r => r.options.id === 'plan-completion-retrieval')
      await q8.update({disabled: true}); await waitFor(() => !core.components.embedding)
      assert.equal(core.components.retrieval, true)
      await retrieval.update({disabled: true}); await waitFor(() => !core.components.retrieval)
      await retrieval.update({disabled: false}); await waitFor(() => core.components.retrieval)
      assert.equal(core.components.embedding, false, 'retrieval cannot revive a disabled Q8 row')
      await q8.update({disabled: false}); await waitFor(() => core.components.embedding)
      await retrieval.update({disabled: true}); await waitFor(() => !core.components.retrieval)
      assert.equal(core.components.embedding, true)
      await rows.find(r => r.options.id === 'plan-completion').update({disabled: true})
      await waitFor(() => !ctx.get('planCompletion'))
      assert.equal(core.components.embedding, false)
    }
    console.log(JSON.stringify({mode, rows: rows.length, metadata: 'zh/en', pass: true}))
  } finally { await ctx.fiber.dispose() }
}
