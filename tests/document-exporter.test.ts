import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { saveDownloadableFile } from '../src/main/document-exporter'

describe('saveDownloadableFile', () => {
  const created: string[] = []

  afterEach(async () => {
    await Promise.all(created.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
  })

  async function outputDir(): Promise<string> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'aster-file-test-'))
    created.push(folder)
    return path.join(folder, 'downloads')
  }

  it('creates a real DOCX and contains traversal filenames', async () => {
    const downloadDir = await outputDir()
    const docx = await saveDownloadableFile({
      downloadDir,
      filename: '../../customer report.txt',
      format: 'docx',
      title: 'Customer report',
      content: '# Findings\n- Verified item'
    })
    expect(path.dirname(docx.path)).toBe(downloadDir)
    expect(docx.filename).toBe('customer report.docx')
    expect((await readFile(docx.path)).subarray(0, 2).toString()).toBe('PK')
  })

  it('preserves multilingual PDF input for the Chromium renderer and writes its result unchanged', async () => {
    const downloadDir = await outputDir()
    const pdfDocument = await PDFDocument.create()
    pdfDocument.addPage()
    const bytes = await pdfDocument.save()
    const renderPdf = vi.fn(async (_html: string) => bytes)
    const content = 'Khammam: ఖమ్మం\nहिन्दी विवरण\nPrice ₹ 100 — € 20\n<img src=x onerror=alert(1)>'
    const saved = await saveDownloadableFile({
      downloadDir,
      filename: 'report.pdf',
      format: 'pdf',
      title: 'పంపిణీదారులు & ग्राहक',
      content,
      renderPdf
    })

    expect(renderPdf).toHaveBeenCalledOnce()
    const html = renderPdf.mock.calls[0][0]
    expect(html).toContain('Khammam: ఖమ్మం\nहिन्दी विवरण\nPrice ₹ 100 — € 20')
    expect(html).toContain('పంపిణీదారులు &amp; ग्राहक')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    expect(await readFile(saved.path)).toEqual(Buffer.from(bytes))
  })

  it('never saves a lossy fallback or an invalid PDF when the renderer is unavailable', async () => {
    const downloadDir = await outputDir()
    const input = { downloadDir, filename: 'report.pdf', format: 'pdf', content: 'తెలుగు ₹' }
    await expect(saveDownloadableFile(input)).rejects.toThrow('PDF rendering is unavailable')
    await expect(saveDownloadableFile({
      ...input,
      renderPdf: async () => Buffer.from('<html>not a PDF</html>')
    })).rejects.toThrow('invalid file')
    await expect(readdir(downloadDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps both reports when repeated or sanitized filenames collide', async () => {
    const downloadDir = await outputDir()
    const first = await saveDownloadableFile({
      downloadDir, filename: 'report?.txt', format: 'txt', content: 'First report: ఖమ్మం ₹ 100'
    })
    const second = await saveDownloadableFile({
      downloadDir, filename: 'report*.txt', format: 'txt', content: 'Second report'
    })

    expect(first.path).not.toBe(second.path)
    expect(await readFile(first.path, 'utf8')).toBe('First report: ఖమ్మం ₹ 100\n')
    expect(await readFile(second.path, 'utf8')).toBe('Second report\n')
  })

  it('validates JSON and escapes active HTML content', async () => {
    const downloadDir = await outputDir()
    await expect(saveDownloadableFile({
      downloadDir,
      filename: 'bad.json',
      format: 'json',
      content: '{bad json}'
    })).rejects.toThrow('JSON content is invalid')

    const html = await saveDownloadableFile({
      downloadDir,
      filename: 'safe.html',
      format: 'html',
      title: '<script>alert(1)</script>',
      content: '<img src=x onerror=alert(1)>'
    })
    const body = await readFile(html.path, 'utf8')
    expect(body).toContain('&lt;script&gt;')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body).not.toContain('<script>alert(1)</script>')
  })

  it('writes spreadsheet-friendly UTF-8 CSV and rejects unsupported formats', async () => {
    const downloadDir = await outputDir()
    const csv = await saveDownloadableFile({
      downloadDir,
      filename: 'contacts',
      format: 'csv',
      content: 'Name,City\nKarthik,Khammam'
    })
    expect(await readFile(csv.path, 'utf8')).toBe('\uFEFFName,City\r\nKarthik,Khammam\r\n')

    await expect(saveDownloadableFile({
      downloadDir,
      filename: 'unsafe.exe',
      format: 'exe',
      content: 'not executable'
    })).rejects.toThrow('Unsupported file format')
  })
})
