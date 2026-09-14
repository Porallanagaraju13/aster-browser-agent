import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Action, Artifact, Attachment } from './types'

export const DOCUMENT_LIMITS = {
  files: 10,
  fileBytes: 10 * 1024 * 1024,
  totalAttachmentBytes: 20 * 1024 * 1024,
  textCharacters: 30_000,
  contentCharacters: 500_000,
  artifactBytes: 20 * 1024 * 1024,
  rows: 10_000,
  columns: 50,
  cells: 100_000,
  cellCharacters: 32_000,
  docxParagraphs: 10_000,
  zipEntries: 2_000,
  expandedZipBytes: 20 * 1024 * 1024,
  pdfPages: 200,
} as const

type DocumentAction = Extract<Action, { type: 'save_file' | 'save_spreadsheet' }>
const MIME = {
  txt: 'text/plain;charset=utf-8', md: 'text/markdown;charset=utf-8',
  csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
  html: 'text/html;charset=utf-8', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** A generated name is a basename, never a local path or an executable extension. */
export function safeFilename(requested: string, extension: keyof typeof MIME): string {
  const leaf = requested.trim().split(/[\\/]/).pop() || 'aster-file'
  let stem = leaf.replace(/\.[^.]*$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '-')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '') || 'aster-file'
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`
  return `${stem}.${extension}`
}

function checkedText(content: string): string {
  if (!content.trim()) throw new Error('The document content cannot be empty.')
  if (content.length > DOCUMENT_LIMITS.contentCharacters) throw new Error('Document content exceeds 500,000 characters.')
  validateCharacters(content)
  return content.replace(/\r\n?/g, '\n')
}

function validateCharacters(content: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new Error('Document contains unsupported control characters.')
  // Encoding lone surrogates silently replaces text; fail instead of claiming a faithful export.
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Document contains invalid Unicode text.')
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Document contains invalid Unicode text.')
  }
}

export function spreadsheetText(value: string): string {
  if (value.length > DOCUMENT_LIMITS.cellCharacters) throw new Error('Spreadsheet cells are limited to 32,000 characters.')
  validateCharacters(value)
  // Excel and other spreadsheet applications may interpret these prefixes as formulas.
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, closedQuote = false
  const endField = () => {
    if (field.length > DOCUMENT_LIMITS.cellCharacters) throw new Error('Spreadsheet cells are limited to 32,000 characters.')
    row.push(field)
    if (row.length > DOCUMENT_LIMITS.columns) throw new Error('Spreadsheets are limited to 50 columns.')
    field = ''; closedQuote = false
  }
  const endRow = () => {
    endField(); rows.push(row); row = []
    if (rows.length > DOCUMENT_LIMITS.rows + 1) throw new Error('Spreadsheets are limited to 10,000 data rows.')
  }
  const input = content.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') { quoted = false; closedQuote = true }
      else field += char
    } else if (char === ',') endField()
    else if (char === '\n') endRow()
    else if (char === '"' && !field && !closedQuote) quoted = true
    else {
      if (closedQuote || char === '"') throw new Error('CSV quoting is invalid.')
      field += char
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.')
  if (field || row.length || closedQuote || !input.endsWith('\n')) endRow()
  return rows
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

async function createPdf(content: string): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  document.setCreator('Aster Browser Extension')
  const font = await document.embedFont(StandardFonts.Helvetica)
  const normalized = content.replace(/\t/g, '    ')
  try { font.encodeText(normalized.replace(/\n/g, '')) }
  catch { throw new Error('PDF export currently supports Latin/Windows-1252 text only. Choose DOCX, HTML or TXT to preserve Unicode, emoji and non-Latin scripts.') }
  const fontSize = 11, lineHeight = 16, margin = 48, width = 595.28, height = 841.89
  const maxWidth = width - margin * 2
  const widths = new Map<string, number>()
  let page = document.addPage([width, height]), y = height - margin, pages = 1
  const draw = (line: string) => {
    if (y < margin) {
      if (++pages > DOCUMENT_LIMITS.pdfPages) throw new Error('PDF export is limited to 200 pages. Choose DOCX or TXT for this document.')
      page = document.addPage([width, height]); y = height - margin
    }
    if (line) page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.09, 0.1, 0.12) })
    y -= lineHeight
  }
  for (const paragraph of normalized.split('\n')) {
    let line = '', used = 0
    for (const char of paragraph) {
      const charWidth = widths.get(char) ?? font.widthOfTextAtSize(char, fontSize)
      widths.set(char, charWidth)
      if (used + charWidth > maxWidth) { draw(line); line = ''; used = 0 }
      line += char; used += charWidth
    }
    draw(line)
  }
  return document.save()
}

async function createDocx(content: string): Promise<Blob> {
  const lines = content.split('\n')
  if (lines.length > DOCUMENT_LIMITS.docxParagraphs) throw new Error('DOCX export is limited to 10,000 paragraphs. Choose TXT for this document.')
  const children = lines.map((line) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) return new Paragraph({ text: heading[2], heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1].length - 1] })
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    return bullet ? new Paragraph({ text: bullet[1], bullet: { level: 0 } })
      : new Paragraph({ children: [new TextRun(line)] })
  })
  return Packer.toBlob(new Document({ creator: 'Aster Browser Extension', sections: [{ children }] }))
}

export async function createArtifact(action: DocumentAction): Promise<Artifact> {
  let blob: Blob
  const format = action.type === 'save_spreadsheet' ? 'xlsx' : action.format
  const name = safeFilename(action.filename, format)
  if (action.type === 'save_spreadsheet') {
    if (!action.columns.length || action.columns.length > DOCUMENT_LIMITS.columns) throw new Error('Spreadsheets require 1–50 columns.')
    if (action.rows.length > DOCUMENT_LIMITS.rows) throw new Error('Spreadsheets are limited to 10,000 data rows.')
    if (action.rows.length * action.columns.length > DOCUMENT_LIMITS.cells) throw new Error('Spreadsheets are limited to 100,000 data cells.')
    let characters = action.columns.reduce((sum, value) => sum + value.length, 0)
    if (characters > DOCUMENT_LIMITS.contentCharacters) throw new Error('Spreadsheet content exceeds 500,000 characters.')
    for (const row of action.rows) {
      if (row.length !== action.columns.length) throw new Error('Each spreadsheet row must match the column count.')
      characters += row.reduce((sum, value) => sum + value.length, 0)
      if (characters > DOCUMENT_LIMITS.contentCharacters) throw new Error('Spreadsheet content exceeds 500,000 characters.')
    }
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Aster Browser Extension'
    const sheet = workbook.addWorksheet('Results', { views: [{ state: 'frozen', ySplit: 1 }] })
    sheet.addRow(action.columns.map(spreadsheetText))
    for (const row of action.rows) sheet.addRow(row.map(spreadsheetText))
    sheet.getRow(1).font = { bold: true, color: { argb: 'FF172018' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4F86B' } }
    sheet.columns.forEach((column, index) => { column.width = Math.min(50, Math.max(16, action.columns[index].length + 3)) })
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, action.rows.length + 1), column: action.columns.length } }
    const bytes = await workbook.xlsx.writeBuffer()
    blob = new Blob([new Uint8Array(bytes)], { type: MIME.xlsx })
  } else {
    const content = checkedText(action.content)
    switch (action.format) {
      case 'pdf': blob = new Blob([new Uint8Array(await createPdf(content))], { type: MIME.pdf }); break
      case 'docx': blob = await createDocx(content); break
      case 'json': {
        let parsed: unknown
        try { parsed = JSON.parse(content) } catch { throw new Error('JSON content is invalid. Supply a complete JSON value.') }
        blob = new Blob([`${JSON.stringify(parsed, null, 2)}\n`], { type: MIME.json }); break
      }
      case 'csv': {
        const rows = parseCsv(content)
        blob = new Blob(['\uFEFF', rows.map((row) => row.map((cell) => `"${spreadsheetText(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n'), '\r\n'], { type: MIME.csv }); break
      }
      case 'html': {
        // User/model markup is presented as text. The exported file contains no executable payload.
        blob = new Blob([`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style>body{max-width:820px;margin:48px auto;padding:0 24px;font:16px/1.65 system-ui,sans-serif;color:#172018}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><pre>${escapeHtml(content)}</pre></body></html>`], { type: MIME.html }); break
      }
      case 'txt': case 'md': blob = new Blob([content, content.endsWith('\n') ? '' : '\n'], { type: MIME[action.format] }); break
      default: throw new Error('Unsupported document format.')
    }
  }
  if (blob.size > DOCUMENT_LIMITS.artifactBytes) throw new Error('Generated files are limited to 20 MiB.')
  return { id: crypto.randomUUID(), name, blob, mime: MIME[format], size: blob.size }
}

/** Inspect declared expanded sizes before any ZIP inflation to limit document zip bombs. */
function validateZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break }
  }
  if (end < 0) throw new Error('The attachment is not a supported Office ZIP document.')
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Multi-disk Office documents are unsupported.')
  const entries = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true)
  if (!entries || entries > DOCUMENT_LIMITS.zipEntries || size === 0xffffffff || offset === 0xffffffff || offset + size !== end) throw new Error('The Office document archive exceeds safe limits or uses an unsupported ZIP format.')
  let cursor = offset, total = 0
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Office document ZIP directory is invalid.')
    const flags = view.getUint16(cursor + 8, true), compressed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true)
    if (flags & 1) throw new Error('Password-protected Office documents cannot be read.')
    total += expanded
    if (expanded > 5 * 1024 * 1024 || total > DOCUMENT_LIMITS.expandedZipBytes || expanded > Math.max(1, compressed) * 250) throw new Error('Office document expansion exceeds safe limits.')
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
    if (cursor > end) throw new Error('Office document ZIP directory is invalid.')
  }
  if (cursor !== end) throw new Error('Office document ZIP directory is invalid.')
}

function xmlDocument(value: string): XMLDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('Office XML contains unsupported document declarations.')
  const document = new DOMParser().parseFromString(value, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw new Error('The Office document contains invalid XML.')
  return document
}

function boundedZipText(file: JSZip.JSZipObject, budget: { used: number }): Promise<string> {
  // JSZip documents this API but omits it from JSZipObject's TypeScript definition.
  const entry = file as JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('uint8array')
    const chunks: Uint8Array[] = []
    let size = 0, stopped = false
    stream.on('data', (chunk) => {
      if (stopped) return
      size += chunk.byteLength; budget.used += chunk.byteLength
      if (size > 5 * 1024 * 1024 || budget.used > DOCUMENT_LIMITS.expandedZipBytes) {
        stopped = true; chunks.length = 0; stream.pause()
        reject(new Error('Office document expansion exceeds safe limits.'))
      } else chunks.push(chunk)
    }).on('error', reject).on('end', () => {
      if (stopped) return
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch { reject(new Error('Office document XML is not valid UTF-8.')) }
    }).resume()
  })
}

async function officeText(bytes: Uint8Array, extension: string): Promise<string> {
  validateZip(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const budget = { used: 0 }
  const readXml = async (path: string) => {
    const file = zip.file(path)
    if (!file) return undefined
    return xmlDocument(await boundedZipText(file, budget))
  }
  if (extension === 'docx') {
    const document = await readXml('word/document.xml')
    if (!document) throw new Error('DOCX attachment does not contain a Word document.')
    const paragraphs = Array.from(document.getElementsByTagNameNS('*', 'p'))
    let text = ''
    for (const paragraph of paragraphs) {
      text += Array.from(paragraph.getElementsByTagNameNS('*', 't')).map((node) => node.textContent ?? '').join('') + '\n'
      if (text.length > DOCUMENT_LIMITS.textCharacters) break
    }
    return text.slice(0, DOCUMENT_LIMITS.textCharacters)
  }
  const stringsDocument = await readXml('xl/sharedStrings.xml')
  const strings = stringsDocument ? Array.from(stringsDocument.getElementsByTagNameNS('*', 'si')).map((node) => node.textContent ?? '') : []
  const sheets = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path)).sort()
  if (!sheets.length) throw new Error('XLSX attachment does not contain a worksheet.')
  let text = ''
  for (const path of sheets) {
    const document = await readXml(path)
    if (!document) continue
    text += `[${path.split('/').pop()}]\n`
    for (const row of Array.from(document.getElementsByTagNameNS('*', 'row')).slice(0, DOCUMENT_LIMITS.rows + 1)) {
      const values = Array.from(row.getElementsByTagNameNS('*', 'c')).slice(0, DOCUMENT_LIMITS.columns).map((cell) => {
        const value = cell.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? ''
        // Read cached values only. Never execute spreadsheet formulas or external links.
        if (cell.getAttribute('t') === 's') return strings[Number(value)] ?? ''
        if (cell.getAttribute('t') === 'inlineStr') return cell.getElementsByTagNameNS('*', 'is')[0]?.textContent ?? ''
        return value
      })
      text += values.join('\t') + '\n'
      if (text.length > DOCUMENT_LIMITS.textCharacters) return text.slice(0, DOCUMENT_LIMITS.textCharacters)
    }
  }
  return text.slice(0, DOCUMENT_LIMITS.textCharacters)
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)))
  return btoa(chunks.join(''))
}

/** Attachments remain in side-panel memory; callers send only text to the model. */
export async function readAttachments(files: File[]): Promise<Attachment[]> {
  if (files.length > DOCUMENT_LIMITS.files) throw new Error('Attach at most 10 files.')
  let total = 0
  for (const file of files) {
    if (file.size > DOCUMENT_LIMITS.fileBytes) throw new Error(`${file.name}: each attachment is limited to 10 MiB.`)
    total += file.size
  }
  if (total > DOCUMENT_LIMITS.totalAttachmentBytes) throw new Error('Attachments are limited to 20 MiB in total.')
  const attachments: Attachment[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const extension = file.name.split('.').pop()?.toLowerCase() || ''
    let text: string | undefined
    if (extension === 'docx' || extension === 'xlsx') text = await officeText(bytes, extension)
    else if (/^(txt|md|markdown|csv|tsv|json|jsonl|xml|html|htm|yaml|yml|log|rtf|js|ts|tsx|jsx|css|py|sql|ini|toml|rst)$/.test(extension) || file.type.startsWith('text/')) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, DOCUMENT_LIMITS.textCharacters) }
      catch { throw new Error(`${file.name}: text is not valid UTF-8. Convert it to UTF-8 before attaching.`) }
    }
    attachments.push({ id: crypto.randomUUID(), name: file.name.split(/[\\/]/).pop() || 'attachment', type: file.type || 'application/octet-stream', size: bytes.length, base64: bytesToBase64(bytes), ...(text !== undefined ? { text } : {}) })
  }
  return attachments
}

/** Resolve when Chrome has accepted the download; retain its URL until completion. */
export async function downloadArtifact(artifact: Artifact): Promise<void> {
  const url = URL.createObjectURL(artifact.blob)
  let downloadId: number | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = () => {
    if (timer) clearTimeout(timer)
    chrome.downloads.onChanged.removeListener(changed)
    window.removeEventListener('pagehide', cleanup)
    URL.revokeObjectURL(url)
  }
  const changed = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.id === downloadId && (delta.state?.current === 'complete' || delta.state?.current === 'interrupted')) cleanup()
  }
  chrome.downloads.onChanged.addListener(changed)
  window.addEventListener('pagehide', cleanup, { once: true })
  try {
    downloadId = await chrome.downloads.download({ url, filename: artifact.name, saveAs: false, conflictAction: 'uniquify' })
    if (typeof downloadId !== 'number') throw new Error('Chrome did not accept the file download.')
    timer = setTimeout(cleanup, 5 * 60_000)
    // Very small files can finish before download() resolves and before the ID is known.
    const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => [])
    if (item?.state === 'complete' || item?.state === 'interrupted') cleanup()
  } catch (error) { cleanup(); throw error }
}
