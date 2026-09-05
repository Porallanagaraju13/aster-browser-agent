import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadArtifact } from '../shared/types'

const MAX_RUNS = 100
const MAX_FILES = 500

function isImmediateChild(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return Boolean(relative) && relative !== '..' && !path.isAbsolute(relative) && path.dirname(relative) === '.'
}

function canSkipEntry(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
}

/** List deliverables independently of the live timeline, including previous application sessions. */
export async function listDownloadArtifacts(artifactsRoot: string): Promise<DownloadArtifact[]> {
  let root: string
  try {
    root = await realpath(artifactsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const runs: Array<{ directory: string; runId: string; modified: number }> = []
  try {
    for await (const entry of await opendir(root)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      try {
        const directory = await realpath(path.join(root, entry.name))
        if (!isImmediateChild(root, directory)) continue
        const info = await stat(directory)
        if (!info.isDirectory()) continue
        runs.push({ directory, runId: entry.name, modified: info.mtimeMs })
        runs.sort((a, b) => b.modified - a.modified || b.runId.localeCompare(a.runId))
        if (runs.length > MAX_RUNS) runs.pop()
      } catch (error) {
        if (!canSkipEntry(error)) throw error
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const files: Array<DownloadArtifact & { modified: number }> = []
  for (const run of runs) {
    try {
      const requestedDirectory = path.join(run.directory, 'downloads')
      const directoryInfo = await lstat(requestedDirectory)
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue
      const directory = await realpath(requestedDirectory)
      if (!isImmediateChild(run.directory, directory)) continue
      for await (const entry of await opendir(directory)) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue
        try {
          const filePath = await realpath(path.join(directory, entry.name))
          if (!isImmediateChild(directory, filePath)) continue
          const info = await stat(filePath)
          if (!info.isFile()) continue
          files.push({
            path: filePath,
            name: entry.name,
            runId: run.runId,
            size: info.size,
            createdAt: (info.birthtimeMs > 0 ? info.birthtime : info.mtime).toISOString(),
            modified: info.mtimeMs
          })
          files.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
          if (files.length > MAX_FILES) files.pop()
        } catch (error) {
          if (!canSkipEntry(error)) throw error
        }
      }
    } catch (error) {
      if (!canSkipEntry(error)) throw error
    }
  }
  return files.map(({ modified: _modified, ...artifact }) => artifact)
}
