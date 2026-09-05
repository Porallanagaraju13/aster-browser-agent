import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const MAX_UPLOAD_FILES = 20
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024
export const MAX_UPLOAD_TOTAL_BYTES = 500 * 1024 * 1024

export function requestedUploadPaths(args: Record<string, unknown>): string[] {
  const values = args.paths === undefined ? [args.path] : args.paths
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_UPLOAD_FILES) {
    throw new Error(`Choose between 1 and ${MAX_UPLOAD_FILES} upload files.`)
  }
  if (!values.every((value): value is string => typeof value === 'string' && Boolean(value.trim()))) {
    throw new Error('Every upload path must be a nonempty absolute file path.')
  }
  if (values.some((value) => !path.isAbsolute(value))) {
    throw new Error('Upload paths must be absolute paths from the approved attachments or task.')
  }
  return [...new Set(values.map((value) => path.resolve(value)))]
}

/** Shared by the native attachment picker and the browser upload tool. No file type is excluded. */
export async function validateUploadFiles(paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const requested = requestedUploadPaths({ paths })
  let totalBytes = 0
  const validated: string[] = []
  for (const requestedPath of requested) {
    const canonicalPath = await realpath(requestedPath)
    const info = await stat(canonicalPath)
    if (!info.isFile()) throw new Error(`${path.basename(requestedPath)} is not a regular file.`)
    if (info.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`${path.basename(requestedPath)} exceeds the 100 MB limit per file.`)
    }
    totalBytes += info.size
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw new Error('The combined upload size exceeds 500 MB.')
    if (!validated.includes(canonicalPath)) validated.push(canonicalPath)
  }
  return validated
}

const MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc', '.dot'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls', '.xlt'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/rtf': ['.rtf'],
  'application/json': ['.json'],
  'application/xml': ['.xml'],
  'application/zip': ['.zip'],
  'application/x-zip-compressed': ['.zip'],
  'application/gzip': ['.gz', '.gzip'],
  'application/x-7z-compressed': ['.7z'],
  'application/vnd.rar': ['.rar'],
  'application/vnd.oasis.opendocument.text': ['.odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
  'text/plain': ['.txt', '.log'],
  'text/markdown': ['.md', '.markdown'],
  'text/csv': ['.csv'],
  'text/html': ['.html', '.htm'],
  'text/xml': ['.xml'],
  'image/jpeg': ['.jpg', '.jpeg', '.jpe'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/svg+xml': ['.svg'],
  'image/tiff': ['.tif', '.tiff'],
  'image/bmp': ['.bmp'],
  'image/heic': ['.heic'],
  'image/avif': ['.avif'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/ogg': ['.ogg', '.oga'],
  'audio/flac': ['.flac'],
  'audio/mp4': ['.m4a'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
  'video/x-msvideo': ['.avi']
}

export function validateWebsiteUpload(
  paths: string[],
  control: { multiple: boolean; accept: string }
): void {
  if (paths.length > 1 && !control.multiple) {
    throw new Error('This website field accepts only one file. Select a single attachment or use separate file fields.')
  }
  const accepted = control.accept.toLowerCase().split(',').map((entry) => entry.trim()).filter(Boolean)
  if (accepted.length === 0 || accepted.includes('*/*')) return
  for (const filePath of paths) {
    const extension = path.extname(filePath).toLowerCase()
    const matches = accepted.some((token) => {
      if (token.startsWith('.')) return filePath.toLowerCase().endsWith(token)
      if (token.endsWith('/*')) {
        return Object.entries(MIME_EXTENSIONS).some(([mime, extensions]) =>
          mime.startsWith(token.slice(0, -1)) && extensions.includes(extension)
        )
      }
      // Unrecognized MIME types are left to the website; this tool supports arbitrary file formats.
      const extensions = MIME_EXTENSIONS[token]
      return extensions ? extensions.includes(extension) : true
    })
    if (!matches) {
      throw new Error(`${path.basename(filePath)} does not match this website field's accepted types: ${control.accept}.`)
    }
  }
}
