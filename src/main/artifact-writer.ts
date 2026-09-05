import { constants } from 'node:fs'
import { copyFile, mkdir, open, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export interface WrittenArtifact {
  path: string
  filename: string
  bytes: number
}

/** Keep model- and server-supplied filenames inside the selected artifact directory. */
export function safeArtifactFilename(requested: string): string {
  const leaf = path.posix.basename(path.win32.basename(requested.trim()))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
  const extension = path.extname(leaf).slice(0, 32)
  let stem = leaf.slice(0, leaf.length - path.extname(leaf).length)
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'aster-file'
  // These device names remain reserved on Windows even when an extension is present.
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`
  return `${stem}${extension}`
}

async function createUniqueArtifact(
  directory: string,
  requestedFilename: string,
  create: (target: string) => Promise<void>
): Promise<WrittenArtifact> {
  await mkdir(directory, { recursive: true })
  const filename = safeArtifactFilename(requestedFilename)
  const extension = path.extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)

  for (let index = 0; index < 10_000; index++) {
    const candidate = index === 0 ? filename : `${stem} (${index + 1})${extension}`
    const target = path.join(directory, candidate)
    try {
      // Creation itself must be exclusive; an existence check alone races other exports.
      await create(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    return { path: target, filename: candidate, bytes: (await stat(target)).size }
  }
  throw new Error('Too many artifacts have this filename. Choose a different filename.')
}

export async function writeUniqueArtifact(
  directory: string,
  requestedFilename: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = 'utf8'
): Promise<WrittenArtifact> {
  return createUniqueArtifact(directory, requestedFilename, async (target) => {
    const handle = await open(target, 'wx')
    try {
      await handle.writeFile(data, typeof data === 'string' ? { encoding } : undefined)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
  })
}

export async function copyUniqueArtifact(
  directory: string,
  requestedFilename: string,
  sourcePath: string
): Promise<WrittenArtifact> {
  return createUniqueArtifact(directory, requestedFilename, (target) =>
    copyFile(sourcePath, target, constants.COPYFILE_EXCL)
  )
}
