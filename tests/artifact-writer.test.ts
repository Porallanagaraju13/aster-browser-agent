import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyUniqueArtifact, writeUniqueArtifact } from '../src/main/artifact-writer'

describe('unique artifact writes', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ))
  })

  async function tempDir(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aster-artifact-writer-test-'))
    directories.push(directory)
    return directory
  }

  it('preserves every concurrent export with the same filename', async () => {
    const directory = await tempDir()
    const files = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      writeUniqueArtifact(directory, 'report.txt', `Report ${index}`)
    ))

    expect(new Set(files.map((file) => file.path)).size).toBe(20)
    for (const [index, file] of files.entries()) {
      expect(await readFile(file.path, 'utf8')).toBe(`Report ${index}`)
      expect(file.bytes).toBe(Buffer.byteLength(`Report ${index}`))
    }
    expect(await readdir(directory)).toHaveLength(20)
  })

  it('copies a download without overwriting an existing export or buffering the source', async () => {
    const base = await tempDir()
    const directory = path.join(base, 'downloads')
    const source = path.join(base, 'playwright-download')
    await writeFile(source, Buffer.from([0, 1, 2, 255]))
    const original = await writeUniqueArtifact(directory, 'contacts.xlsx', 'original workbook')
    const copied = await copyUniqueArtifact(directory, 'contacts.xlsx', source)

    expect(copied.filename).toBe('contacts (2).xlsx')
    expect(await readFile(original.path, 'utf8')).toBe('original workbook')
    expect(await readFile(copied.path)).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(await readFile(source)).toEqual(Buffer.from([0, 1, 2, 255]))
  })

  it('contains traversal names and makes Windows device filenames writable', async () => {
    const directory = await tempDir()
    for (const requested of ['../../report.txt', '..\\..\\report.txt', 'CON.txt', 'aux.log', 'LPT1.pdf']) {
      const file = await writeUniqueArtifact(directory, requested, 'preserved')
      expect(path.dirname(file.path)).toBe(directory)
      expect(await readFile(file.path, 'utf8')).toBe('preserved')
    }
    expect(await readdir(directory)).toContain('_CON.txt')
    expect(await readdir(directory)).toContain('_LPT1.pdf')
  })
})
