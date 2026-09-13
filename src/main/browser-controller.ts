import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type BrowserContext, type Download, type Frame, type Locator, type Page } from 'playwright-core'
import ExcelJS from 'exceljs'
import type {
  ActionResult,
  BrowserAction,
  BrowserElement,
  BrowserTab,
  PageObservation
} from '../shared/types'
import { evaluateNavigation, normalizeAllowlistEntry } from './safety'
import { saveDownloadableFile, type PdfRenderer } from './document-exporter'
import { copyUniqueArtifact, writeUniqueArtifact } from './artifact-writer'
import { requestedUploadPaths, validateUploadFiles, validateWebsiteUpload } from './upload-files'

interface BrowserControllerOptions {
  profileDir: string
  artifactDir: string
  allowlist: string[]
  onNotice: (title: string, detail: string) => void
  headless?: boolean
  renderPdf?: PdfRenderer
}

interface SnapshotResult {
  text: string
  elements: BrowserElement[]
}

export class BrowserController {
  private context?: BrowserContext
  private activePage?: Page
  private step = 0
  private extraArtifact = 0
  private nextTabNumber = 1
  private readonly pendingDownloads = new Set<Page>()
  private snapshotRevision = 0
  private taskWideNavigation = false
  private readonly tabIds = new Map<Page, string>()
  private readonly pageInitialization = new WeakMap<Page, Promise<void>>()
  private readonly videoPaths: Array<Promise<string>> = []
  private readonly elementSnapshots = new WeakMap<Page, Map<string, BrowserElement>>()
  private readonly refFrames = new WeakMap<Page, Map<string, Frame>>()
  private readonly cursorPositions = new WeakMap<Page, { x: number; y: number }>()
  private readonly allowedHosts = new Set<string>()
  private readonly videoDir: string
  private readonly downloadDir: string

  constructor(private readonly options: BrowserControllerOptions) {
    this.videoDir = path.join(options.artifactDir, 'videos')
    this.downloadDir = path.join(options.artifactDir, 'downloads')
    for (const entry of options.allowlist) {
      const normalized = normalizeAllowlistEntry(entry)
      if (normalized) this.allowedHosts.add(normalized)
    }
  }

  async start(): Promise<void> {
    await Promise.all([
      mkdir(this.options.profileDir, { recursive: true }),
      mkdir(this.options.artifactDir, { recursive: true }),
      mkdir(this.videoDir, { recursive: true }),
      mkdir(this.downloadDir, { recursive: true })
    ])

    const executablePath = await this.findChromeExecutable()
    const launchOptions = {
      headless: this.options.headless ?? false,
      chromiumSandbox: true,
      viewport: null,
      acceptDownloads: true,
      recordVideo: { dir: this.videoDir, size: { width: 1360, height: 820 } },
      args: ['--disable-features=Translate', '--no-default-browser-check'],
      ...(executablePath ? { executablePath } : { channel: 'chrome' as const })
    }

    this.context = await chromium.launchPersistentContext(this.options.profileDir, launchOptions)
    await this.context.route('**/*', async (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()) {
        const decision = this.navigationDecision(request.url())
        if (!decision.allowed) {
          this.options.onNotice('Navigation blocked', decision.reason ?? `Blocked ${request.url()}`)
          await route.abort('blockedbyclient').catch(() => undefined)
          return
        }
      }
      await route.continue().catch(() => undefined)
    })
    const initial = this.context.pages()[0] ?? (await this.context.newPage())
    await this.registerPage(initial)

    this.context.on('page', (page) => {
      void this.registerPage(page, true).catch((error) => {
        if (!page.isClosed()) this.options.onNotice('Tab setup failed', error instanceof Error ? error.message : String(error))
      })
    })
  }

  async close(): Promise<string[]> {
    await this.context?.close().catch(() => undefined)
    const videos = await Promise.all(this.videoPaths)
    this.videoPaths.length = 0
    this.context = undefined
    this.activePage = undefined
    this.tabIds.clear()
    return videos.filter(Boolean)
  }

  addAllowedHost(host: string): void {
    const normalized = normalizeAllowlistEntry(host)
    if (normalized) this.allowedHosts.add(normalized)
  }

  getAllowlist(): string[] {
    return [...this.allowedHosts]
  }

  navigationDecision(url: string) {
    const decision = evaluateNavigation(url, this.getAllowlist())
    if (
      this.taskWideNavigation &&
      decision.host &&
      decision.normalizedUrl
    ) {
      return { ...decision, allowed: true, reason: undefined }
    }
    return decision
  }

  enableTaskWideNavigation(): void {
    this.taskWideNavigation = true
  }

  async describeElement(ref: string): Promise<BrowserElement | undefined> {
    return this.elementSnapshots.get(this.requirePage())?.get(ref)
  }

  async describeFocusedElement(): Promise<BrowserElement | undefined> {
    const page = this.requirePage()
    for (const frame of page.frames()) {
      const ref = await frame.evaluate(() => {
        if (!document.hasFocus()) return undefined
        let active = document.activeElement
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
        return active?.getAttribute('data-agent-ref') ?? undefined
      }).catch(() => undefined)
      if (ref) return this.elementSnapshots.get(page)?.get(ref)
    }
    return undefined
  }

  async execute(action: BrowserAction): Promise<ActionResult> {
    try {
      switch (action.name) {
        case 'navigate': {
          const page = this.requirePage()
          const url = String(action.arguments.url ?? '')
          const decision = this.navigationDecision(url)
          if (!decision.allowed || !decision.normalizedUrl) {
            return { ok: false, message: decision.reason ?? 'Navigation blocked.' }
          }
          await page.goto(decision.normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          return { ok: true, message: `Navigated to ${page.url()}` }
        }
        case 'inspect_page':
          return { ok: true, message: 'Inspected the active page.' }
        case 'click': {
          const ref = String(action.arguments.ref ?? '')
          const locator = this.refLocator(ref)
          const point = await this.pointAt(locator)
          await this.pulsePointer(point.page, point.x, point.y)
          await locator.click({ timeout: 8_000 })
          await this.settle()
          return { ok: true, message: `Clicked ${ref}.` }
        }
        case 'type_text': {
          const ref = String(action.arguments.ref ?? '')
          const value = String(action.arguments.text ?? '')
          const locator = this.refLocator(ref)
          const supportsFill = await locator.evaluate((element) => {
            return element instanceof HTMLTextAreaElement ||
              (element instanceof HTMLElement && element.isContentEditable) ||
              (element instanceof HTMLInputElement && !['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden', 'range', 'color'].includes(element.type))
          }, undefined, { timeout: 2_000 }).catch(() => false)
          const editable = supportsFill && await locator.isEditable({ timeout: 2_000 }).catch(() => false)
          if (!editable) {
            const description = await this.describeLiveRef(ref)
            return {
              ok: false,
              message: `Ref ${ref} is ${description} and is not editable with type_text. Re-inspect and use a current text input, textarea, or contenteditable ref. For select fields use select_option; for file fields use upload_file.`
            }
          }
          const point = await this.pointAt(locator)
          await this.pulsePointer(point.page, point.x, point.y)
          await locator.click({ timeout: 8_000 })
          await locator.fill(value, { timeout: 8_000 })
          return { ok: true, message: `Typed ${value.length} character(s) into ${ref}.` }
        }
        case 'hover': {
          const ref = String(action.arguments.ref ?? '')
          const locator = this.refLocator(ref)
          await this.pointAt(locator)
          await locator.hover({ timeout: 8_000 })
          await this.requirePage().waitForTimeout(250)
          return { ok: true, message: `Hovered ${ref}.` }
        }
        case 'select_option': {
          const ref = String(action.arguments.ref ?? '')
          const value = String(action.arguments.value ?? '')
          const locator = this.refLocator(ref)
          const point = await this.pointAt(locator)
          await this.pulsePointer(point.page, point.x, point.y)
          const options = await locator.evaluate((element) => {
            if (!(element instanceof HTMLSelectElement)) throw new Error('The selected ref is not a select field. Re-inspect the page.')
            return [...element.options].map((option) => ({ value: option.value, label: option.label }))
          })
          const match = options.find((option) => option.value === value) ?? options.find((option) => option.label === value)
          if (!match) {
            return { ok: false, message: `Option “${value}” was not found. Available labels: ${options.map((option) => option.label).join(', ').slice(0, 800)}.` }
          }
          const selected = await locator.selectOption({ value: match.value }, { timeout: 2_000 })
          return { ok: true, message: `Selected ${value} in ${ref}.`, data: { selected } }
        }
        case 'check': {
          const ref = String(action.arguments.ref ?? '')
          const checked = Boolean(action.arguments.checked)
          const locator = this.refLocator(ref)
          const point = await this.pointAt(locator)
          await this.pulsePointer(point.page, point.x, point.y)
          await locator.setChecked(checked, { timeout: 8_000 })
          return { ok: true, message: `${checked ? 'Checked' : 'Unchecked'} ${ref}.` }
        }
        case 'scroll': {
          const page = this.requirePage()
          const direction = String(action.arguments.direction ?? 'down')
          const amount = Math.min(Math.max(Number(action.arguments.amount ?? 600), 100), 3_000)
          await page.mouse.wheel(0, direction === 'up' ? -amount : amount)
          await page.waitForTimeout(250)
          return { ok: true, message: `Scrolled ${direction} by ${amount}px.` }
        }
        case 'press_key': {
          const key = String(action.arguments.key ?? '')
          await this.requirePage().keyboard.press(key)
          await this.settle()
          return { ok: true, message: `Pressed ${key}.` }
        }
        case 'go_back':
          await this.requirePage().goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null)
          return { ok: true, message: `Went back to ${this.requirePage().url()}.` }
        case 'go_forward':
          await this.requirePage().goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null)
          return { ok: true, message: `Went forward to ${this.requirePage().url()}.` }
        case 'reload':
          await this.requirePage().reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
          return { ok: true, message: `Reloaded ${this.requirePage().url()}.` }
        case 'new_tab': {
          const page = await this.requireContext().newPage()
          await this.registerPage(page, true)
          const requestedUrl = String(action.arguments.url ?? '').trim()
          if (requestedUrl) {
            const decision = this.navigationDecision(requestedUrl)
            if (!decision.allowed || !decision.normalizedUrl) {
              return { ok: false, message: decision.reason ?? 'New-tab navigation blocked.' }
            }
            await page.goto(decision.normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          }
          return { ok: true, message: `Opened ${this.tabId(page)}${requestedUrl ? ` at ${page.url()}` : ''}.` }
        }
        case 'list_tabs':
          return { ok: true, message: 'Listed browser tabs.', data: { tabs: await this.getTabs() } }
        case 'switch_tab': {
          const tabId = String(action.arguments.tab_id ?? '')
          const page = this.pageForTab(tabId)
          if (!page) return { ok: false, message: `Tab ${tabId} was not found.` }
          this.activePage = page
          await page.bringToFront()
          return { ok: true, message: `Switched to ${tabId}: ${await page.title()}` }
        }
        case 'close_tab': {
          const tabId = String(action.arguments.tab_id ?? '')
          const page = this.pageForTab(tabId)
          if (!page) return { ok: false, message: `Tab ${tabId} was not found.` }
          if (this.openPages().length <= 1) return { ok: false, message: 'The final browser tab cannot be closed.' }
          await page.close()
          if (page === this.activePage) {
            this.activePage = this.openPages()[0]
            await this.activePage?.bringToFront()
          }
          return { ok: true, message: `Closed ${tabId}.` }
        }
        case 'download': {
          const ref = String(action.arguments.ref ?? '')
          const page = this.requirePage()
          const locator = this.refLocator(ref)
          const waiting = this.waitForDownload(page)
          this.pendingDownloads.add(page)
          try {
            const point = await this.pointAt(locator)
            await this.pulsePointer(point.page, point.x, point.y)
            await locator.click({ timeout: 8_000 })
            const outcome = await waiting.promise
            if ('error' in outcome) throw outcome.error
            const source = await outcome.download.path()
            if (!source) throw new Error(await outcome.download.failure() || 'The website did not produce a downloadable file.')
            const saved = await copyUniqueArtifact(this.downloadDir, outcome.download.suggestedFilename(), source)
            return { ok: true, message: `Downloaded ${saved.filename}.`, data: { ...saved } }
          } finally {
            waiting.dispose()
            this.pendingDownloads.delete(page)
          }
        }
        case 'save_spreadsheet': {
          const requestedFilename = String(action.arguments.filename ?? 'browser-results.xlsx')
          const columns = Array.isArray(action.arguments.columns)
            ? action.arguments.columns.map((column) => String(column).trim()).filter(Boolean)
            : []
          const rows = Array.isArray(action.arguments.rows) ? action.arguments.rows : []
          if (columns.length === 0 || columns.length > 50) {
            return { ok: false, message: 'A spreadsheet needs between 1 and 50 named columns.' }
          }
          if (rows.length === 0 || rows.length > 5_000) {
            return { ok: false, message: 'A spreadsheet needs between 1 and 5,000 verified data rows.' }
          }
          if (!rows.every((row) => Array.isArray(row))) {
            return { ok: false, message: 'Every spreadsheet row must be an array of cell values.' }
          }

          const baseName = this.safeFilename(path.basename(requestedFilename).replace(/\.xlsx$/i, ''))
          const filename = `${baseName || 'browser-results'}.xlsx`
          const workbook = new ExcelJS.Workbook()
          workbook.creator = 'Aster Browser Agent'
          workbook.created = new Date()
          const worksheet = workbook.addWorksheet('Results', {
            views: [{ state: 'frozen', ySplit: 1 }]
          })
          worksheet.columns = columns.map((header) => ({
            header: header.slice(0, 180),
            key: header.slice(0, 180),
            width: Math.min(Math.max(header.length + 2, 12), 42)
          }))

          for (const rawRow of rows as unknown[][]) {
            const values = columns.map((_, index) => this.spreadsheetCell(rawRow[index]))
            worksheet.addRow(values)
            values.forEach((value, index) => {
              const displayLength = String(value ?? '').length + 2
              worksheet.getColumn(index + 1).width = Math.min(
                Math.max(worksheet.getColumn(index + 1).width ?? 12, displayLength),
                52
              )
            })
          }

          worksheet.autoFilter = { from: 'A1', to: worksheet.getRow(1).getCell(columns.length).address }
          worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
          worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6FB8' } }
          worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }
          worksheet.getRow(1).height = 24
          worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return
            row.alignment = { vertical: 'top', wrapText: true }
            if (rowNumber % 2 === 1) {
              row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F9FC' } }
            }
          })
          const saved = await writeUniqueArtifact(this.downloadDir, filename, new Uint8Array(await workbook.xlsx.writeBuffer()))
          return {
            ok: true,
            message: `Saved ${rows.length} row(s) to ${saved.filename}.`,
            data: { ...saved, rows: rows.length, columns: columns.length }
          }
        }
        case 'save_file': {
          const saved = await saveDownloadableFile({
            downloadDir: this.downloadDir,
            filename: String(action.arguments.filename ?? 'aster-document.docx'),
            format: String(action.arguments.format ?? 'docx'),
            title: String(action.arguments.title ?? ''),
            content: String(action.arguments.content ?? ''),
            renderPdf: this.options.renderPdf
          })
          return {
            ok: true,
            message: `Saved downloadable ${saved.format.toUpperCase()} file ${saved.filename}.`,
            data: { ...saved }
          }
        }
        case 'upload_file': {
          const ref = String(action.arguments.ref ?? '')
          const paths = await validateUploadFiles(requestedUploadPaths(action.arguments))
          const locator = this.refLocator(ref)
          const control = await locator.evaluate((element) => {
            if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
              throw new Error('The upload ref must identify an input[type=file]. Re-inspect the page for a file input, including hidden upload fields.')
            }
            return { multiple: element.multiple, accept: element.accept, disabled: element.disabled }
          })
          if (control.disabled) return { ok: false, message: 'This website file field is disabled.' }
          validateWebsiteUpload(paths, control)
          if (await locator.isVisible()) {
            const point = await this.pointAt(locator)
            await this.pulsePointer(point.page, point.x, point.y)
          }
          await locator.setInputFiles(paths, { timeout: 10_000 })
          const filenames = paths.map((filePath) => path.basename(filePath))
          return {
            ok: true,
            message: `Selected ${filenames.length} file(s) for upload in ${ref}: ${filenames.join(', ')}.`,
            data: { filenames, count: paths.length }
          }
        }
        case 'screenshot': {
          const fullPage = Boolean(action.arguments.full_page)
          const targetPath = path.join(
            this.options.artifactDir,
            `capture-${String(++this.extraArtifact).padStart(3, '0')}.png`
          )
          await this.captureEvidenceScreenshot(this.requirePage(), {
            path: targetPath,
            type: 'png',
            fullPage
          })
          return { ok: true, message: `Saved ${fullPage ? 'full-page' : 'viewport'} screenshot.`, data: { path: targetPath } }
        }
        case 'wait': {
          const milliseconds = Math.min(Math.max(Number(action.arguments.milliseconds ?? 1_000), 100), 10_000)
          await this.requirePage().waitForTimeout(milliseconds)
          return { ok: true, message: `Waited ${milliseconds}ms.` }
        }
        case 'finish':
          return { ok: true, message: String(action.arguments.summary ?? 'Task completed.') }
        default:
          return { ok: false, message: `Unknown action: ${action.name}` }
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async observe(): Promise<PageObservation> {
    const page = this.requirePage()
    const snapshot = await this.snapshotDom(page)
    this.elementSnapshots.set(
      page,
      new Map(snapshot.elements.map((element) => [element.ref, element]))
    )
    const screenshotPath = path.join(
      this.options.artifactDir,
      `step-${String(++this.step).padStart(3, '0')}.png`
    )
    const screenshot = await this.captureEvidenceScreenshot(page, {
      path: screenshotPath,
      type: 'png',
      fullPage: false
    })

    return {
      url: page.url(),
      title: await page.title(),
      text: snapshot.text,
      elements: snapshot.elements,
      screenshotDataUrl: `data:image/png;base64,${screenshot.toString('base64')}`,
      screenshotPath,
      tabs: await this.getTabs(),
      activeTabId: this.tabId(page)
    }
  }

  private async getTabs(): Promise<BrowserTab[]> {
    return Promise.all(
      this.openPages().map(async (page) => ({
        id: this.tabId(page),
        title: await page.title().catch(() => ''),
        url: page.url(),
        active: page === this.activePage
      }))
    )
  }

  private async snapshotDom(page: Page): Promise<SnapshotResult> {
    const revision = ++this.snapshotRevision
    const refs = new Map<string, Frame>()
    const combined: SnapshotResult = { text: '', elements: [] }
    for (const [frameIndex, frame] of page.frames().slice(0, 20).entries()) {
      const snapshot = await frame.evaluate(({ prefix, budget }) => {
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement
        const style = window.getComputedStyle(html)
        const rect = html.getBoundingClientRect()
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity || 1) > 0 &&
          rect.width > 1 &&
          rect.height > 1 &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= window.innerHeight &&
          rect.left <= window.innerWidth
        )
      }

      const getName = (element: Element): string => {
        const html = element as HTMLElement
        const input = element as HTMLInputElement
        const labelledBy = element.getAttribute('aria-labelledby')
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map((id) => {
            const root = element.getRootNode() as Document | ShadowRoot
            return root.getElementById(id)?.textContent ?? ''
          }).join(' ')
          : ''
        const label = input.labels?.[0]?.innerText ?? ''
        return (
          element.getAttribute('aria-label') ||
          labelledText ||
          label ||
          input.placeholder ||
          input.alt ||
          html.innerText ||
          element.getAttribute('title') ||
          (['button', 'submit', 'reset'].includes(input.type) ? input.value : '') ||
          (input.type === 'file' ? 'Upload file' : '') ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 180)
      }

      const selectors = [
        'a[href]', 'button', 'input', 'textarea', 'select', '[role="button"]', '[role="link"]',
        '[role="checkbox"]', '[role="radio"]', '[role="tab"]', '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(',')

      const roots: Array<Document | ShadowRoot> = [document]
      for (let index = 0; index < roots.length; index += 1) {
        for (const element of roots[index].querySelectorAll('*')) {
          if (element.shadowRoot && !element.hasAttribute('data-aster-agent-pointer')) roots.push(element.shadowRoot)
        }
      }
      for (const root of roots) {
        root.querySelectorAll('[data-agent-ref]').forEach((element) => element.removeAttribute('data-agent-ref'))
      }

      const elements = roots.flatMap((root) => [...root.querySelectorAll(selectors)])
        .filter((element) => isVisible(element) || (element instanceof HTMLInputElement && element.type === 'file'))
        .slice(0, budget)
        .map((element, index) => {
          const ref = `${prefix}e${index + 1}`
          element.setAttribute('data-agent-ref', ref)
          const input = element as HTMLInputElement
          const role = element.getAttribute('role') || (element.tagName.toLowerCase() === 'a' ? 'link' : element.tagName.toLowerCase())
          const descriptor = `${getName(element)} ${input.type ?? ''} ${input.autocomplete ?? ''}`.toLowerCase()
          return {
            ref,
            tag: element.tagName.toLowerCase(),
            role,
            name: getName(element),
            type: element instanceof HTMLButtonElement && !element.form ? 'button' : input.type || undefined,
            href: element instanceof HTMLAnchorElement ? element.href : undefined,
            disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
            sensitive: input.type === 'password' || /(password|passcode|cc-|card|cvv|cvc|one-time-code|otp|ssn)/.test(descriptor),
            checked: ['checkbox', 'radio'].includes(input.type) ? input.checked : undefined
          }
        })

      const shadowText = roots.slice(1).map((root) => root.textContent ?? '').join('\n')
      const text = `${document.body?.innerText ?? ''}\n${shadowText}`.replace(/\n{3,}/g, '\n\n').trim().slice(0, 14_000)
      return { text, elements }
      }, { prefix: `s${revision}f${frameIndex}`, budget: Math.max(0, 250 - combined.elements.length) })
        .catch((error) => {
          if (frame === page.mainFrame()) throw error
          return { text: '', elements: [] } as SnapshotResult
        })
      for (const element of snapshot.elements) refs.set(element.ref, frame)
      combined.elements.push(...snapshot.elements)
      if (snapshot.text) {
        combined.text += `${combined.text ? '\n\n' : ''}${frame === page.mainFrame() ? '' : `[Embedded frame: ${frame.url()}]\n`}${snapshot.text}`
      }
    }
    this.refFrames.set(page, refs)
    combined.text = combined.text.slice(0, 20_000)
    return combined
  }

  private async registerPage(page: Page, makeActive = false): Promise<void> {
    let initialized = this.pageInitialization.get(page)
    if (!initialized) {
      this.tabIds.set(page, `t${this.nextTabNumber++}`)
      const video = page.video()
      if (video) this.videoPaths.push(video.path().catch(() => ''))
      initialized = this.installGuards(page)
      this.pageInitialization.set(page, initialized)
      page.on('close', () => this.tabIds.delete(page))
    }
    await initialized
    if (!this.activePage || makeActive) {
      this.activePage = page
      await page.bringToFront().catch(() => undefined)
    }
  }

  private async installGuards(page: Page): Promise<void> {
    // Playwright routes see only the first URL in a redirect chain. Chromium's
    // request-stage interception also checks every redirected document request.
    const session = await this.requireContext().newCDPSession(page)
    const tree = await session.send('Page.getFrameTree')
    let mainFrameId = tree.frameTree.frame.id
    session.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId) mainFrameId = frame.id
    })
    session.on('Fetch.requestPaused', (event) => {
      const decision = this.navigationDecision(event.request.url)
      if (event.frameId === mainFrameId && !decision.allowed) {
        this.options.onNotice('Navigation blocked', decision.reason ?? `Blocked ${event.request.url}`)
        void session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined)
      } else {
        void session.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined)
      }
    })
    await session.send('Page.enable')
    await session.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }]
    })

    page.on('download', async (download) => {
      if (this.pendingDownloads.delete(page)) {
        return
      }
      await download.cancel().catch(() => undefined)
      this.options.onNotice('Unexpected download blocked', `${download.suggestedFilename()} was not approved.`)
    })

    page.on('filechooser', async (chooser) => {
      await chooser.setFiles([]).catch(() => undefined)
      this.options.onNotice('Unexpected file picker blocked', 'Use the task-scoped upload_file action instead.')
    })

    page.on('dialog', async (dialog) => {
      await dialog.dismiss().catch(() => undefined)
      this.options.onNotice('Browser dialog dismissed', `${dialog.type()}: ${dialog.message()}`)
    })

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const url = frame.url()
      if (!url || url === 'about:blank') return
      const decision = this.navigationDecision(url)
      if (!decision.allowed) {
        this.options.onNotice('Unexpected navigation', decision.reason ?? `Blocked ${url}`)
        void page.goBack({ waitUntil: 'domcontentloaded', timeout: 5_000 }).catch(() => undefined)
      }
    })
  }

  private waitForDownload(page: Page): {
    promise: Promise<{ download: Download } | { error: Error }>
    dispose: () => void
  } {
    let settle!: (result: { download: Download } | { error: Error }) => void
    const promise = new Promise<{ download: Download } | { error: Error }>((resolve) => { settle = resolve })
    const dispose = (): void => {
      clearTimeout(timer)
      page.off('download', onDownload)
      page.off('close', onClose)
    }
    const onDownload = (download: Download): void => { dispose(); settle({ download }) }
    const onClose = (): void => { dispose(); settle({ error: new Error('The tab closed before the download started.') }) }
    const timer = setTimeout(() => {
      dispose()
      settle({ error: new Error('The website did not start a download within 15 seconds. Re-inspect its export controls.') })
    }, 15_000)
    page.on('download', onDownload)
    page.on('close', onClose)
    return { promise, dispose }
  }

  private async captureEvidenceScreenshot(
    page: Page,
    options: Parameters<Page['screenshot']>[0]
  ): Promise<Buffer> {
    return page.screenshot({ scale: 'css', ...options })
  }

  private async installPointerOverlay(page: Page): Promise<void> {
    await page.evaluate(() => {
      const overlayId = '__aster_agent_pointer_overlay__'
      const existing = document.getElementById(overlayId)
      if (existing?.shadowRoot) return
      existing?.remove()
      if (!document.documentElement) return

      const important = (element: HTMLElement, property: string, value: string): void => {
        element.style.setProperty(property, value, 'important')
      }

      const host = document.createElement('div')
      host.id = overlayId
      host.setAttribute('data-aster-agent-pointer', 'true')
      host.setAttribute('aria-hidden', 'true')
      important(host, 'all', 'initial')
      important(host, 'position', 'fixed')
      important(host, 'inset', '0')
      important(host, 'width', '0')
      important(host, 'height', '0')
      important(host, 'pointer-events', 'none')
      important(host, 'z-index', '2147483647')

      const shadow = host.attachShadow({ mode: 'open' })
      const target = document.createElement('div')
      target.id = 'target'
      important(target, 'position', 'fixed')
      important(target, 'left', '0')
      important(target, 'top', '0')
      important(target, 'width', '0')
      important(target, 'height', '0')
      important(target, 'box-sizing', 'border-box')
      important(target, 'border', '2px solid #b8f34a')
      important(target, 'border-radius', '8px')
      important(target, 'background', 'rgba(184, 243, 74, 0.08)')
      important(target, 'opacity', '0')
      important(target, 'transition', 'opacity 160ms ease-out')
      important(target, 'will-change', 'transform, opacity')

      const cursor = document.createElement('div')
      cursor.id = 'cursor'
      important(cursor, 'position', 'fixed')
      important(cursor, 'left', '0')
      important(cursor, 'top', '0')
      important(cursor, 'width', '25px')
      important(cursor, 'height', '31px')
      important(cursor, 'transform', 'translate3d(-100px, -100px, 0)')
      important(cursor, 'filter', 'drop-shadow(0 2px 4px rgba(0,0,0,.8))')
      important(cursor, 'will-change', 'transform')

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 30')
      svg.setAttribute('width', '24')
      svg.setAttribute('height', '30')
      const pointer = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      pointer.setAttribute('d', 'M2 2V25L8.5 19L13 28L17 26L12.5 17.5H21L2 2Z')
      pointer.setAttribute('fill', '#0b0e0a')
      pointer.setAttribute('stroke', '#f7ffe8')
      pointer.setAttribute('stroke-width', '1.5')
      pointer.setAttribute('stroke-linejoin', 'round')
      const accent = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      accent.setAttribute('cx', '3')
      accent.setAttribute('cy', '3')
      accent.setAttribute('r', '2.5')
      accent.setAttribute('fill', '#b8f34a')
      svg.append(pointer, accent)
      cursor.append(svg)
      shadow.append(target, cursor)
      document.documentElement.append(host)

      document.addEventListener('mousemove', (event) => {
        cursor.style.setProperty(
          'transform',
          `translate3d(${event.clientX}px, ${event.clientY}px, 0)`,
          'important'
        )
      }, true)
    })
  }

  private async pointAt(locator: Locator): Promise<{ page: Page; x: number; y: number }> {
    const page = this.requirePage()
    await locator.scrollIntoViewIfNeeded({ timeout: 8_000 })
    const box = await locator.boundingBox()
    if (!box) throw new Error('The target element has no visible bounding box.')
    await this.installPointerOverlay(page)

    await page.evaluate(({ x, y, width, height }) => {
      const host = document.getElementById('__aster_agent_pointer_overlay__')
      const target = host?.shadowRoot?.getElementById('target') as HTMLElement | null
      if (!target) return
      target.style.setProperty('left', `${Math.max(2, x - 4)}px`, 'important')
      target.style.setProperty('top', `${Math.max(2, y - 4)}px`, 'important')
      target.style.setProperty('width', `${width + 8}px`, 'important')
      target.style.setProperty('height', `${height + 8}px`, 'important')
      target.style.setProperty('opacity', '1', 'important')
      window.setTimeout(() => target.style.setProperty('opacity', '0', 'important'), 900)
    }, box)

    const destination = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const viewport = page.viewportSize() ?? { width: 1360, height: 820 }
    const start = this.cursorPositions.get(page) ?? {
      x: viewport.width / 2,
      y: Math.min(110, viewport.height / 2)
    }
    const reducedMotion = await page.evaluate(() =>
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
    const steps = reducedMotion ? 1 : 16

    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      const eased = 1 - Math.pow(1 - progress, 3)
      await page.mouse.move(
        start.x + (destination.x - start.x) * eased,
        start.y + (destination.y - start.y) * eased
      )
      if (!reducedMotion) await page.waitForTimeout(12)
    }

    this.cursorPositions.set(page, destination)
    return { page, ...destination }
  }

  private async pulsePointer(page: Page, x: number, y: number): Promise<void> {
    await this.installPointerOverlay(page)
    const reducedMotion = await page.evaluate(({ x: pulseX, y: pulseY }) => {
      const host = document.getElementById('__aster_agent_pointer_overlay__')
      const shadow = host?.shadowRoot
      if (!shadow) return true

      const pulse = document.createElement('div')
      pulse.style.setProperty('position', 'fixed', 'important')
      pulse.style.setProperty('left', `${pulseX}px`, 'important')
      pulse.style.setProperty('top', `${pulseY}px`, 'important')
      pulse.style.setProperty('width', '24px', 'important')
      pulse.style.setProperty('height', '24px', 'important')
      pulse.style.setProperty('border', '3px solid #b8f34a', 'important')
      pulse.style.setProperty('border-radius', '999px', 'important')
      pulse.style.setProperty('pointer-events', 'none', 'important')
      pulse.style.setProperty('transform', 'translate(-50%, -50%) scale(.3)', 'important')
      pulse.style.setProperty('opacity', '1', 'important')
      pulse.style.setProperty('will-change', 'transform, opacity', 'important')
      shadow.append(pulse)

      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const animation = pulse.animate(
        reduce
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { transform: 'translate(-50%, -50%) scale(.3)', opacity: 1 },
              { transform: 'translate(-50%, -50%) scale(2.2)', opacity: 0 }
            ],
        { duration: reduce ? 100 : 520, easing: 'cubic-bezier(.2,.8,.2,1)' }
      )
      animation.onfinish = () => pulse.remove()
      return reduce
    }, { x, y })

    await page.waitForTimeout(reducedMotion ? 20 : 90)
  }

  private async settle(): Promise<void> {
    const page = this.requirePage()
    await page.waitForTimeout(500)
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined)
  }

  private refLocator(ref: string) {
    const page = this.requirePage()
    const frame = this.refFrames.get(page)?.get(ref)
    if (!frame || frame.isDetached()) throw new Error(`Ref ${ref} is stale or missing. Re-inspect the current page and use its latest ref.`)
    return frame.locator(`[data-agent-ref="${this.escapeAttribute(ref)}"]`)
  }

  private async describeLiveRef(ref: string): Promise<string> {
    const locator = this.refLocator(ref)
    if ((await locator.count()) === 0) return 'missing from the current DOM'

    return locator.evaluate((element) => {
      const html = element as HTMLElement
      const input = element as HTMLInputElement
      const name = (
        element.getAttribute('aria-label') ||
        input.labels?.[0]?.innerText ||
        input.placeholder ||
        html.innerText ||
        element.getAttribute('title') ||
        ''
      ).replace(/\s+/g, ' ').trim().slice(0, 100)
      const tag = element.tagName.toLowerCase()
      const role = element.getAttribute('role') || (tag === 'a' ? 'link' : tag)
      return `${role}${name ? ` “${name}”` : ''}`
    })
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error('Browser has not started.')
    return this.context
  }

  private requirePage(): Page {
    if (!this.activePage || this.activePage.isClosed()) {
      this.activePage = this.openPages()[0]
    }
    if (!this.activePage) throw new Error('Browser has no open tab.')
    return this.activePage
  }

  private openPages(): Page[] {
    return [...this.tabIds.keys()].filter((page) => !page.isClosed())
  }

  private tabId(page: Page): string {
    let id = this.tabIds.get(page)
    if (!id) {
      id = `t${this.nextTabNumber++}`
      this.tabIds.set(page, id)
    }
    return id
  }

  private pageForTab(tabId: string): Page | undefined {
    return this.openPages().find((page) => this.tabIds.get(page) === tabId)
  }

  private safeFilename(filename: string): string {
    return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180) || 'download.bin'
  }

  private spreadsheetCell(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return value.slice(0, 10_000)
    return JSON.stringify(value).slice(0, 10_000)
  }

  private escapeAttribute(value: string): string {
    return value.replace(/["\\]/g, '\\$&')
  }

  private async findChromeExecutable(): Promise<string | undefined> {
    const configuredPath = process.env['CHROME_PATH']?.trim()
    if (configuredPath) {
      try {
        if ((await stat(configuredPath)).isFile()) return configuredPath
      } catch {
        // Report the configured browser path rather than a developer-only launch error.
      }
      throw new Error('CHROME_PATH does not point to an accessible browser file. Set it to the full path of chrome.exe, or remove CHROME_PATH and install Google Chrome, then restart Aster.')
    }

    const candidates = [
      process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable'
    ].filter((candidate): candidate is string => Boolean(candidate))

    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) return candidate
      } catch {
        // Try the next platform-specific path.
      }
    }
    if (process.platform === 'win32') {
      throw new Error('Google Chrome was not found. Install Google Chrome from https://www.google.com/chrome/ and restart Aster. If Chrome is installed in a custom location, set CHROME_PATH to the full path of chrome.exe.')
    }
    return undefined
  }
}
