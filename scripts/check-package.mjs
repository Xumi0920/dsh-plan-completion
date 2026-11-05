import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = await mkdtemp(join(tmpdir(), 'dpc-package-'))
const npm = process.env.npm_execpath
assert.ok(npm, 'Run with npm run check:package')
function run(args, cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  return r.stdout
}
try {
  const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', root]))
  assert.ok(!packed.files.some(f => /^(test|support|scripts|docs\/(data|screenshots))\//.test(f.path)))
  assert.ok(!packed.files.some(f => /\.(gguf|exe|tgz|log)$/.test(f.path)))
  const install = join(root, 'install'); await mkdir(install)
  run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', install, join(root, packed.filename)], install)
  const pkg = JSON.parse(await readFile(join(install, 'node_modules/dsh-plan-completion/package.json'), 'utf8'))
  const exports = Object.keys(pkg.exports).filter(x => x === '.' || /^\.\/(observer|embedding|generator|retrieval|api)$/.test(x))
  assert.equal(exports.length, 6)
  for (const name of exports) {
    const directory = name === '.' ? 'locale' : 'locale/' + name.slice(2)
    for (const language of ['en', 'zh']) {
      const locale = JSON.parse(await readFile(join(install, 'node_modules/dsh-plan-completion', directory, language + '.json'), 'utf8'))
      assert.ok(locale.meta.title && locale.meta.description)
    }
  }
  const code = `for (const name of ${JSON.stringify(exports)}) { const specifier = 'dsh-plan-completion' + (name === '.' ? '' : name.slice(1)); const m = await import(specifier); if (typeof m.apply !== 'function') throw Error(name); for (const lang of ['en', 'zh']) import.meta.resolve(specifier + '/locale/' + lang + '.json'); import.meta.resolve(specifier + '/icon') }`
  const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: install, encoding: 'utf8', windowsHide: true })
  assert.equal(smoke.status, 0, smoke.stderr)
  console.log(JSON.stringify({ version: pkg.version, files: packed.files.length, unpackedBytes: packed.unpackedSize, exports: exports.length, pass: true }))
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  assert.ok(root.split(sep).at(-1).startsWith('dpc-package-'))
  await rm(root, { recursive: true, force: true })
}
