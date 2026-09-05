import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export async function resolveArtifactFile(artifactsRoot: string, requestedPath: string): Promise<string> {
  if (!requestedPath.trim()) throw new Error('The artifact path is missing.')

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    realpath(artifactsRoot),
    realpath(path.resolve(requestedPath))
  ])
  const relative = path.relative(canonicalRoot, canonicalTarget)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Only files inside Aster’s artifacts folder can be opened or saved.')
  }

  const info = await stat(canonicalTarget)
  if (!info.isFile()) throw new Error('The selected artifact is not a regular file.')
  return canonicalTarget
}
