import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDownloadArtifacts } from '../src/main/download-library'

describe('persistent download library', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ))
  })

  async function tempDir(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aster-download-library-test-'))
    directories.push(directory)
    return directory
  }

  async function putFile(root: string, run: string, name: string, time: number): Promise<string> {
    const filename = path.join(root, run, 'downloads', name)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, name)
    await utimes(filename, time, time)
    return filename
  }

  it('returns no artifacts before the first run', async () => {
    const directory = await tempDir()
    await expect(listDownloadArtifacts(path.join(directory, 'missing'))).resolves.toEqual([])
    await expect(listDownloadArtifacts(directory)).resolves.toEqual([])
  })

  it('finds prior run deliverables, sorts by modification, and excludes screenshots and nested files', async () => {
    const directory = await tempDir()
    const older = await putFile(directory, 'run-1', 'report.docx', 100)
    const newer = await putFile(directory, 'run-2', 'contacts.xlsx', 200)
    await putFile(directory, 'run-2', 'nested/ignored.txt', 300)
    await writeFile(path.join(directory, 'run-2', 'screenshot.png'), 'not a deliverable')
    await writeFile(path.join(directory, 'outside.txt'), 'not in run downloads')

    const files = await listDownloadArtifacts(directory)
    expect(files.map((file) => file.path)).toEqual([await realpath(newer), await realpath(older)])
    expect(files[0]).toMatchObject({ name: 'contacts.xlsx', runId: 'run-2', size: 13 })
    expect(Number.isFinite(Date.parse(files[0].createdAt))).toBe(true)
    expect(files[0]).not.toHaveProperty('modified')
    expect(await listDownloadArtifacts(directory)).toEqual(files)
  })

  it('does not follow run or downloads junctions outside the artifacts root', async () => {
    const base = await tempDir()
    const root = path.join(base, 'artifacts')
    await mkdir(root)
    const external = path.join(base, 'external')
    await putFile(external, 'outside-run', 'secret.txt', 100)
    await symlink(path.join(external, 'outside-run'), path.join(root, 'linked-run'), 'junction')
    await mkdir(path.join(root, 'normal-run'))
    await symlink(
      path.join(external, 'outside-run', 'downloads'),
      path.join(root, 'normal-run', 'downloads'),
      'junction'
    )
    await expect(listDownloadArtifacts(root)).resolves.toEqual([])
  })

  it('limits listing to the newest 100 runs and 500 most recently modified deliverables', async () => {
    const directory = await tempDir()
    const oldFile = await putFile(directory, 'old-run', 'excluded.txt', 9_000)
    await utimes(path.dirname(path.dirname(oldFile)), 1, 1)
    for (let index = 0; index < 100; index++) {
      const run = path.join(directory, `run-${index}`)
      await mkdir(run)
      await utimes(run, index + 10, index + 10)
    }
    const paths = await Promise.all(Array.from({ length: 503 }, (_, index) =>
      putFile(directory, 'run-99', `report-${index}.txt`, index + 100)
    ))

    const files = await listDownloadArtifacts(directory)
    expect(files).toHaveLength(500)
    expect(files[0].path).toBe(await realpath(paths[502]))
    expect(files.at(-1)?.path).toBe(await realpath(paths[3]))
    expect(files.some((file) => file.runId === 'old-run')).toBe(false)
  }, 30_000)
})
