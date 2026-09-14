import { createServer } from 'node:http'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { BrowserController } from '../src/main/browser-controller'
import { isStartupPage, showStartupPage, STARTUP_PAGE_TITLE } from '../src/main/startup-page'
import type { Page } from 'playwright-core'
import type { AddressInfo } from 'node:net'

describe('BrowserController integration', () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect-outside-scope') {
      response.writeHead(302, { location: 'https://blocked-navigation.invalid/account' })
      response.end()
      return
    }
    if (request.url === '/embedded') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><label>Embedded search <input aria-label="Embedded search" type="search"></label>')
      return
    }
    if (request.url === '/download') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="fixture.txt"'
      })
      response.end('downloaded by Aster')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head><title>Agent fixture</title></head>
        <body>
          <h1>Browser controller fixture</h1>
          <button aria-label="Continue safely" onclick="const root=document.getElementById('__aster_agent_pointer_overlay__')?.shadowRoot; this.textContent=root && root.childElementCount > 2 ? 'Verified cursor' : 'Cursor missing'">Continue</button>
          <select aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
          <label><input type="checkbox" /> Accept updates</label>
          <input type="file" aria-label="Upload attachment" />
          <input type="file" aria-label="Hidden documents" multiple hidden accept=".pdf,.xlsx,.docx" />
          <a href="/download">Download fixture</a>
          <div id="shadow-widget"></div>
          <script>document.getElementById('shadow-widget').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow search" type="search">';</script>
          <iframe title="Embedded form" src="/embedded" height="80"></iframe>
        </body>
      </html>`)
  })

  let origin = ''

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })

  it('launches isolated Chrome, maps an element, clicks it, and records artifacts', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aster-browser-test-'))
    const controller = new BrowserController({
      profileDir: path.join(tempRoot, 'profile'),
      artifactDir: path.join(tempRoot, 'artifacts'),
      allowlist: ['127.0.0.1'],
      headless: true,
      onNotice: () => undefined
    })
    let closed = false

    try {
      const uploadPath = path.join(tempRoot, 'upload.txt')
      await writeFile(uploadPath, 'safe fixture', 'utf8')
      const documentPaths = [path.join(tempRoot, 'report.pdf'), path.join(tempRoot, 'data.xlsx')]
      await Promise.all(documentPaths.map((filePath) => writeFile(filePath, 'fixture attachment')))
      await controller.start()
      // The user gets a branded local explanation, while the planner still sees
      // the original empty about:blank state and no fabricated website evidence.
      const initialObservation = await controller.observe()
      expect(initialObservation.url).toBe('about:blank')
      expect(initialObservation.title).toBe('')
      expect(initialObservation.text).toBe('')
      expect(initialObservation.elements).toEqual([])
      expect(initialObservation.tabs[0].title).toBe(STARTUP_PAGE_TITLE)
      const initialPage = (controller as unknown as { activePage: Page }).activePage
      expect(await isStartupPage(initialPage)).toBe(true)
      expect(await showStartupPage(initialPage)).toBe(false) // Never overwrite an existing document.
      expect(await initialPage.locator('h1').innerText()).toBe('Your browser is ready.')
      await initialPage.evaluate(() => {
        window.document.head.replaceChildren()
        window.document.body.innerHTML = '<p>Existing local notes must remain untouched.</p>'
      })
      expect(await showStartupPage(initialPage)).toBe(false)
      expect(await initialPage.locator('body').innerText()).toBe('Existing local notes must remain untouched.')

      const outsideBaseline = controller.navigationDecision('https://example.com')
      expect(outsideBaseline.allowed).toBe(false)
      controller.enableTaskWideNavigation()
      expect(controller.navigationDecision('https://example.com').allowed).toBe(true)
      expect(controller.navigationDecision('file:///C:/Windows/win.ini').allowed).toBe(false)

      const navigation = await controller.execute({
        name: 'navigate',
        arguments: { url: origin },
        callId: 'navigate-1'
      })
      expect(navigation.ok).toBe(true)
      expect(await showStartupPage(initialPage)).toBe(false)
      expect(await isStartupPage(initialPage)).toBe(false)

      const firstObservation = await controller.observe()
      expect(firstObservation.title).toBe('Agent fixture')
      const button = firstObservation.elements.find((item) => item.name === 'Continue safely')
      expect(button).toBeDefined()

      const select = firstObservation.elements.find((item) => item.name === 'Plan')
      const checkbox = firstObservation.elements.find((item) => item.name.includes('Accept updates'))
      const fileInput = firstObservation.elements.find((item) => item.name === 'Upload attachment')
      const downloadLink = firstObservation.elements.find((item) => item.name === 'Download fixture')
      expect(select).toBeDefined()
      expect(checkbox).toBeDefined()
      expect(fileInput).toBeDefined()
      expect(downloadLink).toBeDefined()
      const hiddenUpload = firstObservation.elements.find((item) => item.name === 'Hidden documents')
      const embeddedSearch = firstObservation.elements.find((item) => item.name === 'Embedded search')
      const shadowSearch = firstObservation.elements.find((item) => item.name === 'Shadow search')
      expect(hiddenUpload).toBeDefined()
      expect(embeddedSearch).toBeDefined()
      expect(shadowSearch).toBeDefined()

      expect((await controller.execute({ name: 'type_text', arguments: { ref: embeddedSearch!.ref, text: 'frame content' }, callId: 'embedded-fill' })).ok).toBe(true)
      expect((await controller.execute({ name: 'type_text', arguments: { ref: shadowSearch!.ref, text: 'shadow content' }, callId: 'shadow-fill' })).ok).toBe(true)
      expect((await controller.describeFocusedElement())?.ref).toBe(shadowSearch!.ref)
      expect((await controller.execute({ name: 'upload_file', arguments: { ref: hiddenUpload!.ref, paths: documentPaths }, callId: 'hidden-upload' })).ok).toBe(true)
      const singleField = await controller.execute({ name: 'upload_file', arguments: { ref: fileInput!.ref, paths: documentPaths }, callId: 'single-upload' })
      expect(singleField.ok).toBe(false)
      expect(singleField.message).toContain('only one file')
      const wrongType = await controller.execute({ name: 'upload_file', arguments: { ref: hiddenUpload!.ref, paths: [uploadPath] }, callId: 'wrong-type' })
      expect(wrongType.ok).toBe(false)
      expect(wrongType.message).toContain('accepted types')

      const invalidFill = await controller.execute({
        name: 'type_text',
        arguments: { ref: downloadLink!.ref, text: 'MrBeast' },
        callId: 'invalid-fill-1'
      })
      expect(invalidFill.ok).toBe(false)
      expect(invalidFill.message).toContain('not editable')
      const selectFill = await controller.execute({ name: 'type_text', arguments: { ref: select!.ref, text: 'Pro' }, callId: 'invalid-select-fill' })
      expect(selectFill.ok).toBe(false)
      expect(selectFill.message).toContain('select_option')

      expect((await controller.execute({
        name: 'select_option', arguments: { ref: select!.ref, value: 'Pro' }, callId: 'select-1'
      })).ok).toBe(true)
      expect((await controller.execute({
        name: 'check', arguments: { ref: checkbox!.ref, checked: true }, callId: 'check-1'
      })).ok).toBe(true)
      expect((await controller.execute({
        name: 'upload_file', arguments: { ref: fileInput!.ref, path: uploadPath }, callId: 'upload-1'
      })).ok).toBe(true)

      const download = await controller.execute({
        name: 'download', arguments: { ref: downloadLink!.ref }, callId: 'download-1'
      })
      expect(download.ok).toBe(true)
      await expect(access(String(download.data?.path))).resolves.toBeUndefined()
      const repeatedDownload = await controller.execute({ name: 'download', arguments: { ref: downloadLink!.ref }, callId: 'download-2' })
      expect(repeatedDownload.ok).toBe(true)
      expect(repeatedDownload.data?.path).not.toBe(download.data?.path)
      expect(await readFile(String(download.data?.path), 'utf8')).toBe('downloaded by Aster')

      const spreadsheet = await controller.execute({
        name: 'save_spreadsheet',
        arguments: {
          filename: '../verified-results.xlsx',
          columns: ['Distributor', 'Contact'],
          rows: [['Example Medicals', '2025550100']]
        },
        callId: 'spreadsheet-1'
      })
      expect(spreadsheet.ok).toBe(true)
      const spreadsheetPath = String(spreadsheet.data?.path)
      await expect(access(spreadsheetPath)).resolves.toBeUndefined()
      expect(path.dirname(spreadsheetPath)).toBe(path.join(tempRoot, 'artifacts', 'downloads'))
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(spreadsheetPath)
      expect(workbook.getWorksheet('Results')?.getCell('A2').value).toBe('Example Medicals')
      const repeatedSheet = await controller.execute({ name: 'save_spreadsheet', arguments: { filename: 'verified-results.xlsx', columns: ['New'], rows: [['different content']] }, callId: 'spreadsheet-2' })
      expect(repeatedSheet.ok).toBe(true)
      expect(repeatedSheet.data?.path).not.toBe(spreadsheet.data?.path)

      const document = await controller.execute({
        name: 'save_file',
        arguments: {
          filename: '../verified-report.docx',
          format: 'docx',
          title: 'Verified browser report',
          content: '# Result\nThe browser fixture was verified.'
        },
        callId: 'file-1'
      })
      expect(document.ok).toBe(true)
      const documentPath = String(document.data?.path)
      expect(path.dirname(documentPath)).toBe(path.join(tempRoot, 'artifacts', 'downloads'))
      expect(path.basename(documentPath)).toBe('verified-report.docx')
      expect((await readFile(documentPath)).subarray(0, 2).toString()).toBe('PK')

      const click = await controller.execute({
        name: 'click',
        arguments: { ref: button!.ref },
        callId: 'click-1'
      })
      expect(click.ok).toBe(true)

      const secondObservation = await controller.observe()
      expect(secondObservation.text).toContain('Verified cursor')
      expect(secondObservation.screenshotPath).toContain('step-003.png')
      const staleClick = await controller.execute({ name: 'click', arguments: { ref: button!.ref }, callId: 'stale-click' })
      expect(staleClick.ok).toBe(false)
      expect(staleClick.message).toContain('stale')

      const firstTabId = secondObservation.activeTabId
      const newTab = await controller.execute({
        name: 'new_tab', arguments: { url: `${origin}/second` }, callId: 'tab-1'
      })
      expect(newTab.ok).toBe(true)
      const tabObservation = await controller.observe()
      expect(tabObservation.tabs).toHaveLength(2)
      expect(tabObservation.activeTabId).not.toBe(firstTabId)
      expect((await controller.execute({
        name: 'switch_tab', arguments: { tab_id: firstTabId }, callId: 'switch-1'
      })).ok).toBe(true)
      expect((await controller.execute({
        name: 'close_tab', arguments: { tab_id: tabObservation.activeTabId }, callId: 'close-1'
      })).ok).toBe(true)

      for (let index = 0; index < 30; index += 1) {
        const result = await controller.execute({
          name: index % 2 === 0 ? 'list_tabs' : 'inspect_page',
          arguments: {},
          callId: `scale-${index}`
        })
        expect(result.ok).toBe(true)
      }

      const videos = await controller.close()
      closed = true
      expect(videos.length).toBeGreaterThanOrEqual(2)
      await Promise.all(videos.map((video) => expect(access(video)).resolves.toBeUndefined()))
    } finally {
      if (!closed) await controller.close()
      await rm(tempRoot, { recursive: true, force: true })
    }
  }, 90_000)

  it('blocks a main-frame redirect before requesting an unapproved domain', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aster-navigation-test-'))
    const notices: string[] = []
    const controller = new BrowserController({
      profileDir: path.join(tempRoot, 'profile'),
      artifactDir: path.join(tempRoot, 'artifacts'),
      allowlist: ['127.0.0.1'],
      headless: true,
      onNotice: (title, detail) => notices.push(`${title}: ${detail}`)
    })
    try {
      await controller.start()
      const result = await controller.execute({ name: 'navigate', arguments: { url: `${origin}/redirect-outside-scope` }, callId: 'redirect' })
      expect(result.ok).toBe(false)
      expect(notices.some((notice) => notice.startsWith('Navigation blocked:') && notice.includes('blocked-navigation.invalid'))).toBe(true)
      const newTab = await controller.execute({ name: 'new_tab', arguments: { url: `${origin}/redirect-outside-scope` }, callId: 'new-tab-redirect' })
      expect(newTab.ok).toBe(false)
      expect(notices.filter((notice) => notice.startsWith('Navigation blocked:') && notice.includes('blocked-navigation.invalid'))).toHaveLength(2)
    } finally {
      await controller.close()
      await rm(tempRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
