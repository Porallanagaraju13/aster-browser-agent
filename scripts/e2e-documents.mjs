import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { PDFDocument, PDFRawStream } from 'pdf-lib'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(import.meta.dirname, '..')
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aster-documents-e2e-'))
const helperPath = path.join(dataDir, 'document-helpers.cjs')
const environment = { ...process.env, GEMINI_API_KEY: 'e2e-placeholder-key' }
delete environment.OPENROUTER_API_KEY
delete environment.GROQ_API_KEY
environment.DOTENV_CONFIG_PATH = path.join(dataDir, 'no-environment-file')
let application

try {
  await build({
    entryPoints: [path.join(projectRoot, 'scripts/fixtures/document-helpers.ts')],
    outfile: helperPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })

  application = await electron.launch({
    args: ['.', `--user-data-dir=${dataDir}`],
    cwd: projectRoot,
    env: environment,
    timeout: 90_000
  })
  let page = await application.firstWindow()
  await page.getByText('Aster', { exact: true }).waitFor()

  const unicodeText = 'Khammam: ఖమ్మం\nहिन्दी विवरण\nPrice ₹ 100 — € 20'
  const exported = await application.evaluate(async ({ app, BrowserWindow }, input) => {
    const require = process.getBuiltinModule('node:module').createRequire(input.helperPath)
    const { saveDownloadableFile, renderPdf } = require(input.helperPath)
    const { join } = require('node:path')
    const shown = []
    const onWindow = (_event, window) => {
      window.on('show', () => shown.push(window.id))
      if (window.isVisible()) shown.push(window.id)
    }
    app.on('browser-window-created', onWindow)
    const before = BrowserWindow.getAllWindows().length
    try {
      const options = {
        downloadDir: join(app.getPath('userData'), 'artifacts', 'document-e2e-run', 'downloads'),
        filename: 'multilingual.pdf',
        format: 'pdf',
        title: 'Multilingual document',
        content: input.unicodeText,
        renderPdf
      }
      const first = await saveDownloadableFile(options)
      const second = await saveDownloadableFile(options)
      return { first, second, shown, before, after: BrowserWindow.getAllWindows().length }
    } finally {
      app.removeListener('browser-window-created', onWindow)
    }
  }, { helperPath, unicodeText })

  if (exported.shown.length || exported.before !== exported.after) {
    throw new Error('PDF generation opened a visible window or left a hidden renderer running.')
  }
  if (exported.first.path === exported.second.path) throw new Error('Repeated PDF names replaced an earlier file.')
  const bytes = await readFile(exported.first.path)
  const pdf = await PDFDocument.load(bytes)
  if (pdf.getPageCount() < 1) throw new Error('The exported PDF has no pages.')
  if (process.env.ASTER_DOCUMENT_EVIDENCE_DIR) {
    await mkdir(process.env.ASTER_DOCUMENT_EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(process.env.ASTER_DOCUMENT_EVIDENCE_DIR, 'multilingual.pdf'), bytes)
  }
  const unicodeMaps = []
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue
    let stream
    try { stream = inflateSync(object.getContents()).toString('utf8') } catch { continue }
    if (stream.includes('begincmap')) unicodeMaps.push(stream.toLowerCase())
  }
  const mappings = unicodeMaps.join('\n')
  // Indic conjuncts are shaped into glyphs that do not have individual Unicode mappings.
  // Require representative glyphs from both scripts and the currency/punctuation instead.
  for (const character of ['ఖ', 'మ', 'ం', 'ह', 'व', 'र', 'ण', '₹', '—', '€']) {
    if (!mappings.includes(character.codePointAt(0).toString(16).padStart(4, '0'))) {
      throw new Error(`PDF glyph mappings did not preserve Unicode character ${character}.`)
    }
  }
  if (!Array.from(pdf.context.enumerateIndirectObjects()).some(([, object]) =>
    /\/FontFile(?:2|3)?\s/.test(object.toString())
  )) throw new Error('The PDF did not embed its fonts for portable display.')
  if (process.env.ASTER_PDF_TEST_PYTHON) {
    const extraction = await promisify(execFile)(process.env.ASTER_PDF_TEST_PYTHON, [
      '-c',
      'import json,sys,pypdfium2 as p; d=p.PdfDocument(sys.argv[1]); print(json.dumps("\\n".join(page.get_textpage().get_text_range() for page in d),ensure_ascii=True))',
      exported.first.path
    ])
    const extracted = JSON.parse(extraction.stdout).replace(/\s/g, '')
    if (!extracted.includes(unicodeText.replace(/\s/g, ''))) {
      throw new Error('PDFium text extraction did not preserve the complete multilingual content.')
    }
    console.log('PASS independent PDFium extraction preserves complete multilingual text')
  }
  console.log('PASS actual Chromium PDF preserves Telugu, Hindi, rupee and Unicode glyph mappings')
  console.log('PASS PDF generation creates no visible windows and disposes hidden renderers')

  const uploadPath = path.join(dataDir, 'document-to-attach.txt')
  await writeFile(uploadPath, 'A locally selected document for browser upload.\n')
  await application.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, uploadPath)
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  const removeAttachment = page.getByRole('button', { name: 'Remove attachment document-to-attach.txt', exact: true })
  await removeAttachment.waitFor()
  if (process.env.ASTER_DOCUMENT_EVIDENCE_DIR) {
    await page.screenshot({ path: path.join(process.env.ASTER_DOCUMENT_EVIDENCE_DIR, 'attachment-ui.png') })
  }
  await removeAttachment.click()
  await removeAttachment.waitFor({ state: 'detached' })
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  await page.getByRole('button', { name: 'Attach files', exact: true }).waitFor()
  if (await page.locator('.attached-file').count()) throw new Error('Canceling the attachment picker added a file.')

  const downloads = await page.evaluate(() => window.browserAgent.listDownloads())
  const expected = new Set(await Promise.all([exported.first.path, exported.second.path].map((file) => realpath(file))))
  if (downloads.length !== 2 || downloads.some((file) => !expected.has(file.path))) {
    throw new Error('Persistent downloads omitted generated files or included unrelated run artifacts.')
  }
  await page.getByRole('button', { name: 'Downloads', exact: true }).click()
  await page.getByRole('button', { name: 'Download multilingual.pdf', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Download multilingual (2).pdf', exact: true }).waitFor()
  if (process.env.ASTER_DOCUMENT_EVIDENCE_DIR) {
    await page.screenshot({ path: path.join(process.env.ASTER_DOCUMENT_EVIDENCE_DIR, 'downloads-ui.png') })
  }
  const savedCopyPath = path.join(dataDir, 'saved-user-copy.pdf')
  await application.evaluate(({ dialog }, savedPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedPath })
  }, savedCopyPath)
  await page.getByRole('button', { name: 'Download multilingual.pdf', exact: true }).click()
  // The native save operation is asynchronous; wait on the resulting file with a bounded retry.
  let copied
  for (let attempt = 0; attempt < 40; attempt++) {
    copied = await readFile(savedCopyPath).catch(() => undefined)
    if (copied) break
    await page.waitForTimeout(50)
  }
  if (!copied?.equals(bytes)) throw new Error('The Download button did not save an exact copy through the native dialog.')
  await application.close()
  application = await electron.launch({
    args: ['.', `--user-data-dir=${dataDir}`], cwd: projectRoot, env: environment, timeout: 90_000
  })
  page = await application.firstWindow()
  await page.getByText('Aster', { exact: true }).waitFor()
  const afterRestart = await page.evaluate(() => window.browserAgent.listDownloads())
  if (afterRestart.length !== 2 || afterRestart.some((file) => !expected.has(file.path))) {
    throw new Error('Download library did not survive an application restart.')
  }
  await page.getByRole('button', { name: 'Downloads', exact: true }).click()
  await page.getByRole('button', { name: 'Download multilingual.pdf', exact: true }).waitFor()
  console.log('PASS attachment UI with native picker, remove and cancel behavior')
  console.log('PASS Downloads UI saves an exact copy through the native dialog')
  console.log('PASS generated downloads remain accessible after application restart')
  console.log('PASS repeated file names preserve both deliverables')
} finally {
  if (application) await application.close().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}
