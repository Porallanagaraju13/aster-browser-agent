import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, unzipSync } from 'fflate'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'))
assert.equal(manifest.manifest_version, 3)
assert.equal(manifest.version, JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version)
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'downloads', 'scripting', 'sidePanel', 'storage'].sort())
assert.ok(!manifest.externally_connectable && !manifest.web_accessible_resources && !manifest.content_scripts)
assert.ok(!manifest.content_security_policy.extension_pages.includes('unsafe-eval'))
const entries = {}
async function collect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), 'Symlinks are not allowed in release assets')
    const path = resolve(directory, item.name)
    if (item.isDirectory()) { await collect(path); continue }
    const name = relative(dist, path).split(sep).join('/')
    assert.match(name, /^(?:THIRD_PARTY_NOTICES\.txt|manifest\.json|panel\.html|background\.js|panel\.js|icons\/[a-z0-9.-]+\.png|assets\/[a-zA-Z0-9_.-]+\.(?:js|css|woff2?))$/)
    const bytes = await readFile(path)
    if (/\.(?:js|html|json|css)$/.test(name)) {
      const text = bytes.toString('utf8')
      assert.ok(!/(?:sk-or-v1-[a-f0-9]{40,}|gsk_[A-Za-z0-9]{30,}|test-only-key-never-real)/.test(text), 'Possible credential or test fixture in output')
      assert.ok(!text.includes('sourceMappingURL='), 'Source maps must not be shipped')
    }
    entries[name] = new Uint8Array(bytes)
  }
}
await collect(dist)
assert.ok(entries['manifest.json'] && entries['panel.html'] && entries['background.js'])
const archive = zipSync(entries, { level: 9 })
assert.deepEqual(Object.keys(unzipSync(archive)).sort(), Object.keys(entries).sort())
const name = `Aster-Chrome-Extension-${manifest.version}.zip`
const output = resolve(root, '..', 'release')
await mkdir(output, { recursive: true })
await writeFile(resolve(output, name), archive)
const checksum = createHash('sha256').update(archive).digest('hex')
await writeFile(resolve(output, `Aster-Chrome-Extension-${manifest.version}-SHA256.txt`), `${checksum}  ${name}\n`)
console.log(JSON.stringify({ archive: resolve(output, name), bytes: archive.length, sha256: checksum, entries: Object.keys(entries) }, null, 2))
