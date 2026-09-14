import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

// This is a real SIDE_PANEL context test, separate from the extension-page E2E.
// It uses the unchanged production dist, a fresh disposable profile, and no real keys or websites.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'test-artifacts')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'aster-sidepanel-smoke-'))
const headed = process.env.ASTER_TEST_HEADED === '1'
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', executablePath: process.env.ASTER_TEST_CHROMIUM || undefined,
  headless: !headed,
  viewport: { width: 1000, height: 760 },
  args: [`--disable-extensions-except=${resolve(root, 'dist')}`, `--load-extension=${resolve(root, 'dist')}`, ...(headed ? ['--window-position=-10000,-10000'] : [])]
})
const report = { status: 'running', browser: context.browser()?.version(), headed, productionManifestUnchanged: true, realWebsites: false, realApiKeys: false }
const waitFor = async (check, description, timeout = 10_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

try {
  await context.route(/^https?:\/\//, route => route.abort())
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(worker.url()).host
  const launcher = context.pages()[0]
  await launcher.goto(`chrome-extension://${extensionId}/panel.html`)
  await launcher.getByRole('heading', { name: 'Connect your AI', exact: true }).waitFor()
  const windowId = await launcher.evaluate(async () => (await chrome.windows.getCurrent()).id)
  assert.equal(typeof windowId, 'number')
  const before = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))
  assert.equal(before.length, 0, 'A normal extension tab must not be mistaken for a side panel')

  // A test-only DOM launcher inside the extension page supplies a real button gesture.
  // No production event handlers, manifest entries, or source files are modified.
  await launcher.evaluate((id) => {
    const button = document.createElement('button')
    button.id = 'aster-smoke-open-panel'
    button.textContent = 'Open actual side panel for test'
    button.addEventListener('click', () => {
      chrome.sidePanel.open({ windowId: id }).then(() => { button.dataset.result = 'opened' })
        .catch(error => { button.dataset.result = 'failed'; button.dataset.error = error.message })
    })
    document.body.append(button)
  }, windowId)
  await launcher.locator('#aster-smoke-open-panel').click()
  const openResult = await waitFor(() => launcher.locator('#aster-smoke-open-panel').getAttribute('data-result'), 'the sidePanel.open result')
  assert.equal(openResult, 'opened', await launcher.locator('#aster-smoke-open-panel').getAttribute('data-error') || 'sidePanel.open failed')
  const actual = await waitFor(async () => {
    const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))
    // Chrome may report windowId=-1 for side-panel extension contexts. This fresh
    // single-window profile has only this extension, so the exact URL is sufficient.
    return contexts.find(item => item.documentUrl === `chrome-extension://${extensionId}/panel.html`)
  }, 'an actual SIDE_PANEL runtime context').catch(async error => {
    report.runtimeContextTypes = await worker.evaluate(async () => (await chrome.runtime.getContexts({})).map(item => item.contextType))
    throw error
  })
  report.sidePanelContextCreated = actual.contextType === 'SIDE_PANEL'
  report.sidePanelWindowId = actual.windowId
  assert.equal(actual.contextType, 'SIDE_PANEL')

  const panelPage = context.pages().find(page => page !== launcher && page.url() === actual.documentUrl)
  report.playwrightAttachedPanelPage = Boolean(panelPage)
  if (panelPage) {
    await panelPage.getByRole('heading', { name: 'Connect your AI', exact: true }).waitFor()
    await panelPage.getByLabel('Model ID', { exact: true }).fill('sidepanel-smoke-only-model')
    assert.equal(await panelPage.getByLabel('Model ID', { exact: true }).inputValue(), 'sidepanel-smoke-only-model')
    assert.equal(await panelPage.getByLabel('API key', { exact: true }).inputValue(), '')
    report.panelModelControlVerified = true
  }

  // Chrome can expose side panels as non-page targets. getViews still allows this
  // test's same-extension launcher to inspect its own real panel and observe pagehide.
  const visible = await waitFor(() => launcher.evaluate(() => {
    const views = chrome.extension.getViews().filter(view => view !== window && view.location.pathname.endsWith('/panel.html'))
    const panel = views.find(view => view.document.body?.textContent?.includes('Connect your AI'))
    if (!panel) return undefined
    window.__asterSidePanelSmoke = { pagehide: false, modelControl: Boolean(panel.document.querySelector('input[placeholder*="model ID"]')) }
    panel.addEventListener('pagehide', () => { window.__asterSidePanelSmoke.pagehide = true }, { once: true })
    return { title: panel.document.title, modelControl: window.__asterSidePanelSmoke.modelControl }
  }), 'the mounted Aster UI inside its actual side panel')
  assert.equal(visible.modelControl, true)
  report.panelUiMounted = true
  // Exercise the real React settings UI even when Playwright omits the native
  // side-panel target. These are same-extension test-owned window references.
  await launcher.evaluate(() => {
    const panel = chrome.extension.getViews().find(view => view !== window && view.location.pathname.endsWith('/panel.html'))
    const model = panel.document.querySelector('input[placeholder*="model ID"]')
    const key = panel.document.querySelector('input[type="password"]')
    const setValue = Object.getOwnPropertyDescriptor(panel.HTMLInputElement.prototype, 'value').set
    setValue.call(model, 'sidepanel-smoke-only-model')
    model.dispatchEvent(new panel.Event('input', { bubbles: true }))
    setValue.call(key, 'sidepanel-synthetic-key-not-real')
    key.dispatchEvent(new panel.Event('input', { bubbles: true }))
    panel.document.querySelector('button[type="submit"]').click()
  })
  await waitFor(() => launcher.evaluate(() => {
    const panel = chrome.extension.getViews().find(view => view !== window && view.location.pathname.endsWith('/panel.html'))
    return Boolean(panel?.document.querySelector('.task-form'))
  }), 'successful settings save in the actual side panel')
  report.panelSettingsInteractionVerified = true
  await launcher.evaluate((id) => chrome.sidePanel.close({ windowId: id }), windowId)
  await waitFor(async () => {
    const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))
    return !contexts.some(item => item.contextId === actual.contextId)
  }, 'destruction of the actual side-panel context on close')
  report.sidePanelContextDestroyedOnClose = true
  report.pagehideObserved = await launcher.evaluate(() => Boolean(window.__asterSidePanelSmoke?.pagehide))
  assert.equal(report.pagehideObserved, true, 'The application cancellation handler relies on pagehide')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await writeFile(resolve(output, 'sidepanel-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await context.close()
}
