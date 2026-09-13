import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { configurePackagedRuntime } from '../src/main/packaged-runtime'

const require = createRequire(import.meta.url)
const { verifyRuntime } = require('../scripts/prepare-runtime.cjs') as {
  verifyRuntime: (root: string, descriptors: Array<{ name: string; revision: string }>) => Promise<string[]>
}
const revisions = [{ name: 'ffmpeg', revision: '1011' }, { name: 'winldd', revision: '1007' }]

describe('portable recording dependencies', () => {
  it('uses packaged resources even when a developer cache is inherited', () => {
    const environment = { PLAYWRIGHT_BROWSERS_PATH: 'unavailable-user-cache' }
    const resources = path.resolve('fixture-portable', 'resources')
    configurePackagedRuntime(true, resources, environment)
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe(path.join(resources, 'playwright'))
  })

  it('preserves development runtime configuration', () => {
    const environment = { PLAYWRIGHT_BROWSERS_PATH: 'developer-test-cache' }
    configurePackagedRuntime(false, '/unused', environment)
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe('developer-test-cache')
    const empty = {}
    configurePackagedRuntime(false, '/unused', empty)
    expect(empty).toEqual({})
  })

  it('refuses to package missing, empty, wrong-platform, or unlicensed recorder files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aster-runtime-test-'))
    try {
      await expect(verifyRuntime(root, revisions)).rejects.toThrow('missing or empty')
      await mkdir(path.join(root, 'ffmpeg-1011'))
      await mkdir(path.join(root, 'winldd-1007'))
      const executable = path.join(root, 'ffmpeg-1011', 'ffmpeg-win64.exe')
      await writeFile(executable, '')
      await expect(verifyRuntime(root, revisions)).rejects.toThrow('missing or empty')
      await writeFile(executable, 'ELF fixture')
      await expect(verifyRuntime(root, revisions)).rejects.toThrow('not a Windows executable')
      await writeFile(executable, 'MZ fixture')
      await expect(verifyRuntime(root, revisions)).rejects.toThrow('COPYING.LGPLv2.1')
      await writeFile(path.join(root, 'ffmpeg-1011', 'COPYING.LGPLv2.1'), 'License fixture')
      await expect(verifyRuntime(root, revisions)).rejects.toThrow('PrintDeps.exe')
      await writeFile(path.join(root, 'winldd-1007', 'PrintDeps.exe'), 'MZ fixture')
      await expect(verifyRuntime(root, revisions)).resolves.toHaveLength(3)
      await expect(verifyRuntime(root, [])).rejects.toThrow('revisions')
      await expect(verifyRuntime(root, [{ name: 'ffmpeg', revision: '../escape' }])).rejects.toThrow('revisions')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
