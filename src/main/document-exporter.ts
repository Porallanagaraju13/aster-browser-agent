import path from 'node:path'
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from 'docx'
import { safeArtifactFilename, writeUniqueArtifact } from './artifact-writer'

export const DOWNLOADABLE_FILE_FORMATS = [
  'docx',
  'pdf',
  'txt',
  'md',
  'csv',
  'json',
  'html'
] as const

export type DownloadableFileFormat = (typeof DOWNLOADABLE_FILE_FORMATS)[number]

export type PdfRenderer = (html: string) => Promise<Uint8Array>

interface SaveDownloadableFileInput {
  downloadDir: string
  filename: string
  format: string
  title?: string
  content: string
  renderPdf?: PdfRenderer
}

export interface SavedDownloadableFile {
  path: string
  filename: string
  format: DownloadableFileFormat
  bytes: number
}

const EXTENSION: Record<DownloadableFileFormat, string> = {
  docx: '.docx',
  pdf: '.pdf',
  txt: '.txt',
  md: '.md',
  csv: '.csv',
  json: '.json',
  html: '.html'
}

const MAX_CONTENT_CHARACTERS = 500_000

export async function saveDownloadableFile(
  input: SaveDownloadableFileInput
): Promise<SavedDownloadableFile> {
  const format = input.format.trim().toLowerCase() as DownloadableFileFormat
  if (!DOWNLOADABLE_FILE_FORMATS.includes(format)) {
    throw new Error(
      `Unsupported file format “${input.format}”. Use ${DOWNLOADABLE_FILE_FORMATS.join(', ')}.`
    )
  }

  if (!input.content.trim()) throw new Error('The file content cannot be empty.')
  if (input.content.length > MAX_CONTENT_CHARACTERS) {
    throw new Error(`File content is limited to ${MAX_CONTENT_CHARACTERS.toLocaleString()} characters.`)
  }

  const extension = EXTENSION[format]
  const filename = downloadableFilename(input.filename, extension)
  const title = input.title?.trim().slice(0, 300) || ''
  let data: string | Uint8Array

  switch (format) {
    case 'docx':
      data = await createDocx(title, input.content)
      break
    case 'pdf': {
      if (!input.renderPdf) {
        throw new Error('PDF rendering is unavailable. Reopen Aster or choose DOCX to preserve the document text.')
      }
      // Chromium shapes complex scripts and embeds the locally available font glyphs.
      // Never replace unsupported characters with question marks and report success.
      data = await input.renderPdf(createHtml(title, input.content))
      if (Buffer.from(data.subarray(0, 5)).toString('ascii') !== '%PDF-') {
        throw new Error('PDF rendering returned an invalid file. No artifact was saved.')
      }
      break
    }
    case 'json': {
      let parsed: unknown
      try {
        parsed = JSON.parse(input.content)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`JSON content is invalid: ${detail}`)
      }
      data = `${JSON.stringify(parsed, null, 2)}\n`
      break
    }
    case 'html':
      data = createHtml(title, input.content)
      break
    case 'md':
      data = `${title ? `# ${title}\n\n` : ''}${input.content.trim()}\n`
      break
    case 'txt':
      data = `${title ? `${title}\n${'='.repeat(Math.min(title.length, 80))}\n\n` : ''}${input.content.trim()}\n`
      break
    case 'csv':
      // A UTF-8 BOM keeps non-ASCII text readable when the CSV is opened in Excel.
      data = `\uFEFF${input.content.replace(/^\uFEFF/, '').trim().replace(/\r?\n/g, '\r\n')}\r\n`
      break
  }

  const artifact = await writeUniqueArtifact(input.downloadDir, filename, data)
  return { ...artifact, format }
}

function downloadableFilename(requested: string, extension: string): string {
  const leaf = path.posix.basename(path.win32.basename(requested.trim() || `aster-file${extension}`))
  const withoutExtension = leaf.replace(/\.[a-z0-9]{1,8}$/i, '')
  return safeArtifactFilename(`${withoutExtension || 'aster-file'}${extension}`)
}

async function createDocx(title: string, content: string): Promise<Buffer> {
  const children: Paragraph[] = []
  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }))
  }

  for (const line of normalizeLines(content)) {
    if (!line) {
      children.push(new Paragraph(''))
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
        heading[1].length - 1
      ]
      children.push(new Paragraph({ text: heading[2], heading: level }))
      continue
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      children.push(new Paragraph({ text: bullet[1], bullet: { level: 0 } }))
      continue
    }

    children.push(new Paragraph({ children: [new TextRun(line)] }))
  }

  const document = new Document({
    creator: 'Aster Browser Agent',
    title: title || 'Aster document',
    sections: [{ properties: {}, children }]
  })
  return Packer.toBuffer(document)
}

function createHtml(title: string, content: string): string {
  const safeTitle = escapeHtml(title || 'Aster document')
  const safeContent = escapeHtml(content.trim())
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>@page{size:A4;margin:18mm}body{max-width:820px;margin:48px auto;padding:0 24px;font:16px/1.65 system-ui,"Nirmala UI","Noto Sans",sans-serif;color:#17191c}h1{line-height:1.35;overflow-wrap:anywhere}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}h1{font-size:20pt;break-after:avoid}}</style>
</head>
<body>${title ? `<h1>${safeTitle}</h1>` : ''}<pre>${safeContent}</pre></body>
</html>
`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeLines(content: string): string[] {
  return content.replace(/\r\n?/g, '\n').trim().split('\n')
}
