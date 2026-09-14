import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { createArtifact, DOCUMENT_LIMITS, downloadArtifact, readAttachments, safeFilename, spreadsheetText } from '../src/documents'
import type { Action } from '../src/types'

const fileAction = (format: Extract<Action, { type: 'save_file' }>['format'], content: string, filename = 'report') => ({ type: 'save_file' as const, filename, format, content })
const dom = new JSDOM('')
beforeAll(() => { vi.stubGlobal('DOMParser', dom.window.DOMParser) })
afterAll(() => { vi.unstubAllGlobals(); dom.window.close() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('document files', () => {
  it('creates real UTF-8 TXT and Markdown files', async () => {
    for (const format of ['txt', 'md'] as const) {
      const artifact = await createArtifact(fileAction(format, '# Report\nతెలుగు 😀'))
      expect(artifact.name).toBe(`report.${format}`)
      expect(await artifact.blob.text()).toBe('# Report\nతెలుగు 😀\n')
      expect(artifact.size).toBe(artifact.blob.size)
      expect(artifact.id).toBeTruthy()
    }
  })

  it('validates and prettifies JSON', async () => {
    const artifact = await createArtifact(fileAction('json', '{"contacts":[{"name":"Aster"}]}'))
    expect(JSON.parse(await artifact.blob.text())).toEqual({ contacts: [{ name: 'Aster' }] })
    await expect(createArtifact(fileAction('json', '{bad'))).rejects.toThrow('JSON content is invalid')
  })

  it('exports safe inert HTML instead of executing supplied markup', async () => {
    const artifact = await createArtifact(fileAction('html', '<script>fetch("https://evil.test")</script><img src=x onerror=alert(1)>'))
    const html = await artifact.blob.text()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
    expect(new JSDOM(html).window.document.querySelectorAll('script,img').length).toBe(0)
  })

  it('creates a valid paginated PDF and rejects unsupported characters without corruption', async () => {
    const artifact = await createArtifact(fileAction('pdf', Array.from({ length: 140 }, (_, n) => `Line ${n}: café – report`).join('\n')))
    expect(new TextDecoder().decode((await artifact.blob.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
    const pdf = await PDFDocument.load(await artifact.blob.arrayBuffer())
    expect(pdf.getPageCount()).toBeGreaterThan(1)
    await expect(createArtifact(fileAction('pdf', 'తెలుగు report 😀'))).rejects.toThrow('Choose DOCX')
  })

  it('creates a valid DOCX with Unicode and headings', async () => {
    const artifact = await createArtifact(fileAction('docx', '# Results\nతెలుగు 😀\n- Contact 1'))
    const zip = await JSZip.loadAsync(await artifact.blob.arrayBuffer())
    expect(zip.file('[Content_Types].xml')).not.toBeNull()
    const document = await zip.file('word/document.xml')!.async('string')
    expect(document).toContain('తెలుగు 😀')
    expect(document).toContain('Heading1')
  })

  it('neutralizes CSV formulas, preserves quoting, Unicode and multiline fields', async () => {
    const artifact = await createArtifact(fileAction('csv', 'Name,Note\nతెలుగు,"=HYPERLINK(""https://evil.test"")"\nOther,"line 1\nline 2"'))
    const text = await artifact.blob.text()
    expect(text).toContain('"\'=HYPERLINK(""https://evil.test"")"')
    expect(text).toContain('తెలుగు')
    expect(text).toContain('"line 1\nline 2"')
    expect(new Uint8Array(await artifact.blob.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([239, 187, 191]))
    for (const prefix of ['=SUM(1,2)', '+cmd', '-1', '@SUM(A1)', '  =1', '\tvalue']) expect(spreadsheetText(prefix)).toBe(`'${prefix}`)
    expect(spreadsheetText('9849390000')).toBe('9849390000')
  })

  it('rejects malformed CSV', async () => {
    for (const text of ['a,"unclosed', 'a,"closed"extra', 'a,b"c']) await expect(createArtifact(fileAction('csv', text))).rejects.toThrow(/CSV/)
  })

  it('creates XLSX with string-only safe cells and correctly preserved phone numbers', async () => {
    const artifact = await createArtifact({ type: 'save_spreadsheet', filename: '../contacts.xlsm', columns: ['Name', 'Phone'], rows: [['=EVIL()', '001234'], ['తెలుగు', '+9112345']] })
    expect(artifact.name).toBe('contacts.xlsx')
    const bytes = await artifact.blob.arrayBuffer()
    expect(new Uint8Array(bytes).slice(0, 2)).toEqual(new Uint8Array([80, 75]))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes)
    const sheet = workbook.getWorksheet('Results')!
    expect(sheet.getCell('A2').value).toBe("'=EVIL()")
    expect(sheet.getCell('B2').value).toBe('001234')
    expect(sheet.getCell('B3').value).toBe("'+9112345")
    expect(sheet.getCell('A2').formula).toBeUndefined()
    expect(sheet.getRow(1).font.bold).toBe(true)
  })

  it('enforces row, column, cell and content bounds', async () => {
    await expect(createArtifact({ type: 'save_spreadsheet', filename: 'a', columns: ['a'], rows: [['a', 'b']] })).rejects.toThrow('match the column')
    await expect(createArtifact({ type: 'save_spreadsheet', filename: 'a', columns: [], rows: [] })).rejects.toThrow('1–50')
    await expect(createArtifact({ type: 'save_spreadsheet', filename: 'a', columns: Array(51).fill('a'), rows: [] })).rejects.toThrow('1–50')
    await expect(createArtifact({ type: 'save_spreadsheet', filename: 'a', columns: ['a'], rows: Array(10001).fill(['a']) })).rejects.toThrow('10,000')
    expect(() => spreadsheetText('a'.repeat(32_001))).toThrow('32,000')
    await expect(createArtifact(fileAction('txt', 'a'.repeat(500_001)))).rejects.toThrow('500,000')
    await expect(createArtifact(fileAction('docx', 'a\u0000b'))).rejects.toThrow('control characters')
    await expect(createArtifact(fileAction('txt', '\ud800'))).rejects.toThrow('invalid Unicode')
    await expect(createArtifact(fileAction('txt', '  '))).rejects.toThrow('empty')
    await expect(createArtifact(fileAction('docx', 'line\n'.repeat(10_001)))).rejects.toThrow('10,000 paragraphs')
    await expect(createArtifact({ type: 'save_spreadsheet', filename: 'a', columns: Array(50).fill('a'), rows: Array(2_001).fill(Array(50).fill('')) })).rejects.toThrow('100,000 data cells')
  })

  it('removes paths, reserved names, invalid filename characters and executable extensions', () => {
    expect(safeFilename('C:\\secret\\..\\CON.exe', 'pdf')).toBe('_CON.pdf')
    expect(safeFilename('../../a<b>:c.xlsm', 'xlsx')).toBe('a-b--c.xlsx')
    expect(safeFilename('...  ', 'txt')).toBe('aster-file.txt')
    expect(safeFilename('report\u202etxt.exe', 'docx')).toBe('report-txt.docx')
    expect(safeFilename('a'.repeat(300), 'txt').length).toBe(104)
  })
})

describe('user-selected attachments', () => {
  it('retains arbitrary binary files for upload only and caps text sent to the model', async () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 42])
    const files = await readAttachments([new File([bytes], 'archive.bin'), new File(['x'.repeat(40_000)], 'note.txt', { type: 'text/plain' })])
    expect(files[0]).toMatchObject({ name: 'archive.bin', type: 'application/octet-stream', size: 5, base64: 'AAH/gCo=' })
    expect(files[0].text).toBeUndefined()
    expect(files[1].text).toHaveLength(30_000)
    expect(files[0].id).not.toBe(files[1].id)
  })

  it('checks all size/count limits before reading any file', async () => {
    const file = new File(['x'], 'small.txt')
    await expect(readAttachments(Array(11).fill(file))).rejects.toThrow('10 files')
    const huge = new File([''], 'huge.bin')
    Object.defineProperty(huge, 'size', { value: DOCUMENT_LIMITS.fileBytes + 1 })
    await expect(readAttachments([huge])).rejects.toThrow('10 MiB')
    const medium = new File([''], 'medium.bin')
    Object.defineProperty(medium, 'size', { value: 8 * 1024 * 1024 })
    await expect(readAttachments([medium, medium, medium])).rejects.toThrow('20 MiB')
  })

  it('rejects invalid text encodings rather than corrupting the text', async () => {
    await expect(readAttachments([new File([new Uint8Array([0xff, 0xfe, 0xff])], 'text.txt')])).rejects.toThrow('not valid UTF-8')
  })

  it('reads generated DOCX/XLSX text locally without evaluating formulas', async () => {
    const docx = await createArtifact(fileAction('docx', '# Report\nతెలుగు 😀'))
    const xlsx = await createArtifact({ type: 'save_spreadsheet', filename: 'contacts', columns: ['Name', 'Number'], rows: [['Aster', '00123']] })
    const attachments = await readAttachments([new File([docx.blob], docx.name), new File([xlsx.blob], xlsx.name)])
    expect(attachments[0].text).toContain('తెలుగు 😀')
    expect(attachments[1].text).toContain('Aster\t00123')
  })

  it('rejects malformed Office files, XML entities and zip expansion bombs', async () => {
    await expect(readAttachments([new File(['not zip'], 'bad.docx')])).rejects.toThrow('supported Office ZIP')
    const entity = new JSZip()
    entity.file('word/document.xml', '<!DOCTYPE doc [<!ENTITY x "secret">]><doc>&x;</doc>')
    await expect(readAttachments([new File([new Uint8Array(await entity.generateAsync({ type: 'uint8array' }))], 'entities.docx')])).rejects.toThrow('declarations')
    const bomb = new JSZip()
    bomb.file('word/document.xml', 'x'.repeat(6 * 1024 * 1024))
    await expect(readAttachments([new File([new Uint8Array(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))], 'bomb.docx')])).rejects.toThrow('expansion exceeds')
  })
})

describe('downloads', () => {
  it('starts a real Chrome download and revokes its URL after completion', async () => {
    vi.stubGlobal('window', new EventTarget())
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>()
    const download = vi.fn().mockResolvedValue(42)
    vi.stubGlobal('chrome', { downloads: { download, search: vi.fn().mockResolvedValue([{ state: 'in_progress' }]), onChanged: { addListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) => listeners.add(fn), removeListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) => listeners.delete(fn) } } })
    const artifact = await createArtifact(fileAction('txt', 'Hello'))
    await downloadArtifact(artifact)
    expect(create).toHaveBeenCalledWith(artifact.blob)
    expect(download).toHaveBeenCalledWith({ url: 'blob:test', filename: 'report.txt', saveAs: false, conflictAction: 'uniquify' })
    expect(revoke).not.toHaveBeenCalled()
    for (const listener of listeners) listener({ id: 42, state: { current: 'complete' } })
    expect(revoke).toHaveBeenCalledWith('blob:test')
    expect(listeners.size).toBe(0)
  })

  it('cleans up rejected downloads', async () => {
    vi.stubGlobal('window', new EventTarget())
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failed')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const removeListener = vi.fn()
    vi.stubGlobal('chrome', { downloads: { download: vi.fn().mockRejectedValue(new Error('Download blocked')), onChanged: { addListener: vi.fn(), removeListener } } })
    await expect(downloadArtifact(await createArtifact(fileAction('txt', 'Hello')))).rejects.toThrow('Download blocked')
    expect(revoke).toHaveBeenCalledWith('blob:failed')
    expect(removeListener).toHaveBeenCalled()
  })
})
