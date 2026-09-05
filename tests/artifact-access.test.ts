import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveArtifactFile } from '../src/main/artifact-access'

describe('resolveArtifactFile', () => {
  const created: string[] = []

  afterEach(async () => {
    await Promise.all(created.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
  })

  it('allows regular artifact files and rejects paths outside the artifacts root', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'aster-artifact-access-'))
    created.push(base)
    const root = path.join(base, 'artifacts')
    const inside = path.join(root, 'run-1', 'report.docx')
    const outside = path.join(base, 'outside.txt')
    await mkdir(path.dirname(inside), { recursive: true })
    await writeFile(inside, 'inside')
    await writeFile(outside, 'outside')

    await expect(resolveArtifactFile(root, inside)).resolves.toBe(await realpath(inside))
    await expect(resolveArtifactFile(root, outside)).rejects.toThrow('inside Aster’s artifacts folder')
    await expect(resolveArtifactFile(root, path.dirname(inside))).rejects.toThrow('regular file')
  })
})
