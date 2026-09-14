import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'

// Only a temporary browser profile, synthetic website, and mocked provider are used.
// No personal Chrome profile, real API key, paid call, or customer website is accessed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const providers = {
  openrouter: { label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'test/mock-model' },
  groq: { label: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'groq-test-model' },
  gemini: { label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-test-model' },
}
const provider = process.env.ASTER_TEST_PROVIDER || 'openrouter'
assert.ok(Object.hasOwn(providers, provider), 'ASTER_TEST_PROVIDER must be openrouter, groq, or gemini')
const selectedProvider = providers[provider]
const testKey = 'test-only-key-never-real'
const output = resolve(root, 'test-artifacts', provider)
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'aster-extension-e2e-'))
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Aster test directory</title><body>
<h1>Distributor directory · sample data</h1><a id="logo" href="/" title="Directory home">Aster Directory</a>
<form id="search"><label>City <input id="city" aria-label="City"></label><label>Region <select id="region" aria-label="Region"><option value="all">All regions</option><option value="telangana">Telangana</option></select></label><button type="submit">Search</button></form>
<p id="region-status">All regions selected</p>
<label>Upload note<input type="file" aria-label="Upload note" id="upload"></label>
<p id="upload-status">No uploaded file</p><div id="results">Search for a city.</div>
<div style="height:1300px" aria-hidden="true"></div><footer><h2>Lower directory section</h2><p>SCROLL-EVIDENCE-240</p></footer>
<script>document.querySelector('#search').onsubmit=e=>{e.preventDefault();document.body.dataset.searchCount=String(Number(document.body.dataset.searchCount||0)+1);document.querySelector('#results').innerHTML='<h2>Khammam</h2><table><tr><th>Name</th><th>Contact</th></tr><tr><td>Sample Distribution</td><td>TEST-CONTACT-01</td></tr></table>'};document.querySelector('#city').onkeydown=e=>{if(e.key==='Enter')document.body.dataset.enterCount=String(Number(document.body.dataset.enterCount||0)+1)};document.querySelector('#region').onchange=e=>{document.querySelector('#region-status').textContent='Selected '+e.target.selectedOptions[0].text};document.querySelector('#upload').onchange=e=>{document.querySelector('#upload-status').textContent='Uploaded '+e.target.files[0].name};</script></body></html>`
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
// Native optional-permission dialogs cannot be accepted in a headless browser.
// Use a disposable copy with ONLY the local fixture host pregranted, never alter dist/release.
const testExtension = resolve(profile, 'test-extension')
await cp(resolve(root, 'dist'), testExtension, { recursive: true })
const testManifest = JSON.parse(await readFile(resolve(testExtension, 'manifest.json'), 'utf8'))
testManifest.host_permissions.push(`${origin}/*`)
await writeFile(resolve(testExtension, 'manifest.json'), JSON.stringify(testManifest))
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', executablePath: process.env.ASTER_TEST_CHROMIUM || undefined,
  headless: true, acceptDownloads: true, downloadsPath: resolve(output, 'downloads'), viewport: { width: 420, height: 900 },
  args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`]
})
const errors = []
const interceptionErrors = []
const unexpectedNetwork = []
let panel
let calls = 0
let mode = 'flow'
// Fail closed even during onboarding, before the selected provider mock is installed.
await context.route(/^https?:\/\//, async route => {
  const url = new URL(route.request().url())
  if (url.origin === origin) { await route.continue(); return }
  unexpectedNetwork.push(`${url.origin}${url.pathname}`)
  await route.abort()
})
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 })
  const extensionId = new URL(worker.url()).host
  const page = context.pages()[0]
  await page.goto(origin)
  panel = await context.newPage()
  panel.on('pageerror', error => errors.push(error.message))
  await panel.goto(`chrome-extension://${extensionId}/panel.html`)
  await panel.getByRole('combobox').selectOption(provider)
  await panel.getByLabel('Model ID', { exact: true }).fill(selectedProvider.model)
  await panel.getByLabel('API key', { exact: true }).fill(testKey)
  await panel.getByRole('button', { name: 'Save and open workspace' }).click()
  // Keep website active while controlling extension-page UI (same logic as side panel).
  await page.bringToFront()
  await panel.getByRole('button', { name: 'Refresh selected tab' }).click()
  await panel.getByLabel('What should we do?', { exact: true }).fill('Navigate to the directory page, search Khammam in Telangana using Enter and Search, upload my attached note, inspect the lower page by scrolling, and create an Excel spreadsheet, PDF and DOCX report using the observed sample data.')
  await panel.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'approved-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Approved sample note') })
  await panel.getByRole('button', { name: 'Remove approved-note.txt' }).waitFor()
  await panel.getByLabel('Allow form submissions', { exact: false }).check()
  await panel.getByLabel('I approve this task', { exact: false }).check()
  await context.route(/^https?:\/\//, async route => {
    try {
    const request = route.request()
    const url = new URL(request.url())
    assert.ok(!request.url().includes(testKey), 'The API key must never appear in a URL or query')
    if (url.origin === origin) { await route.continue(); return }
    if (request.url() !== selectedProvider.endpoint) {
      unexpectedNetwork.push(`${url.origin}${url.pathname}`)
      await route.abort()
      return
    }
    calls++
    assert.equal(url.search, '', 'Provider endpoint must not have query parameters')
    assert.equal(request.method(), 'POST')
    assert.equal(request.headers().authorization, `Bearer ${testKey}`)
    const payload = request.postDataJSON()
    assert.equal(payload.model, selectedProvider.model, 'The selected exact model must reach its provider')
    assert.ok(!JSON.stringify(payload).includes(testKey), 'The API key must not appear in prompts or payloads')
    if (mode === 'hold') { await new Promise(resolve => setTimeout(resolve, 1500)); await route.abort().catch(() => {}); return }
    if (mode === 'quota') { await route.fulfill({ status: 429, body: `private error ${testKey}`, contentType: 'text/plain' }); return }
    const data = JSON.parse(payload.messages[1].content)
    assert.equal(data.approval.attachments, undefined, 'binary attachments must not leak in approval')
    assert.ok(!payload.messages[1].content.includes('test-only-key-never-real'))
    assert.ok(!payload.messages[1].content.includes(Buffer.from('Approved sample note').toString('base64')))
    const ref = name => {
      const element = data.currentObservation.elements.find(item => item.name === name)
      assert.ok(element, `Missing live element ${name}`)
      return element.ref
    }
    const actions = [
      () => ({ type: 'fill', ref: ref('Directory home'), text: 'Khammam' }), // regression: must be rejected
      () => ({ type: 'navigate', url: `${origin}/directory` }),
      () => ({ type: 'fill', ref: ref('City'), text: 'Khammam' }),
      () => ({ type: 'select', ref: ref('Region'), value: 'telangana' }),
      () => ({ type: 'press', ref: ref('City'), key: 'Enter' }),
      () => ({ type: 'click', ref: ref('Search') }),
      () => ({ type: 'upload', ref: ref('Upload note'), attachmentIds: [data.attachments[0].id] }),
      () => ({ type: 'scroll', direction: 'down', amount: 1200 }),
      () => { assert.match(data.currentObservation.text, /SCROLL-EVIDENCE-240/, 'Scrolling must expose lower-page data to the agent'); return { type: 'scroll', direction: 'up', amount: 1200 } },
      () => { assert.match(data.currentObservation.text, /TEST-CONTACT-01/, 'Exports must use data observed after scrolling back'); return { type: 'save_spreadsheet', filename: 'sample-distributors.xlsx', columns: ['Name', 'Contact'], rows: [['Sample Distribution', 'TEST-CONTACT-01']] } },
      () => ({ type: 'save_file', filename: 'sample-report.pdf', format: 'pdf', content: '# Khammam directory\nSample Distribution: TEST-CONTACT-01\nSynthetic test data.' }),
      () => ({ type: 'save_file', filename: 'sample-report.docx', format: 'docx', content: '# Khammam directory\nSample Distribution: TEST-CONTACT-01\nSynthetic test data.' }),
      () => ({ type: 'finish', outcome: 'completed', summary: 'Verified one sample distributor, uploaded the approved note, and created the Excel, PDF and Word files.' })
    ]
    const action = (actions[calls - 1] || (() => ({ type: 'finish', outcome: 'incomplete', summary: 'Unexpected test step.' })))()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(action) } }] }) })
    } catch (error) {
      interceptionErrors.push(error instanceof Error ? error.message : String(error))
      await route.abort().catch(() => {})
    }
  })
  await panel.getByRole('button', { name: 'Start task' }).click()
  await panel.getByRole('heading', { name: 'Task result', exact: true }).waitFor({ timeout: 45000 })
  const result = await panel.locator('.result').innerText()
  assert.match(result, /Verified one sample distributor/)
  assert.equal(await page.locator('#city').inputValue(), 'Khammam')
  assert.equal(new URL(page.url()).pathname, '/directory')
  assert.equal(await page.locator('#region').inputValue(), 'telangana')
  assert.equal(await page.locator('#region-status').innerText(), 'Selected Telangana')
  assert.equal(await page.locator('body').getAttribute('data-enter-count'), '1')
  assert.equal(await page.locator('body').getAttribute('data-search-count'), '2')
  assert.equal(await page.evaluate(() => scrollY), 0)
  assert.match(await page.locator('#results').innerText(), /TEST-CONTACT-01/)
  assert.equal(await page.locator('#logo').innerText(), 'Aster Directory')
  assert.match(await page.locator('#upload-status').innerText(), /approved-note.txt/)
  assert.equal(calls, 13)
  assert.deepEqual(interceptionErrors, [])
  assert.deepEqual(unexpectedNetwork, [])
  const local = await panel.evaluate(() => chrome.storage.local.get(null))
  assert.ok(!JSON.stringify(local).includes('test-only-key-never-real'), 'key must not be persisted')
  await panel.screenshot({ path: resolve(output, 'workspace.png'), fullPage: true })
  await panel.getByRole('button', { name: 'View downloadable files' }).click()
  const downloads = panel.getByRole('button', { name: 'Download ↓', exact: true })
  assert.equal(await downloads.count(), 3)
  const savedFiles = []
  for (let index = 0; index < 3; index++) {
    const event = panel.waitForEvent('download', { timeout: 15000 })
    await downloads.nth(index).click()
    const download = await event
    // CDP's download event can precede Chrome extension filename determination.
    const filename = await panel.locator('.file-list strong').nth(index).innerText()
    const path = resolve(output, filename)
    await download.saveAs(path)
    savedFiles.push(filename)
    const bytes = await readFile(path)
    if (filename.endsWith('.pdf')) assert.ok((await PDFDocument.load(bytes)).getPageCount() > 0)
    else assert.ok(unzipSync(bytes)['[Content_Types].xml'])
  }
  await panel.screenshot({ path: resolve(output, 'files.png'), fullPage: true })
  await panel.evaluate(await readFile(resolve(root, 'node_modules/axe-core/axe.min.js'), 'utf8'))
  const accessibility = await panel.evaluate(async () => {
    const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })
    return result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target) }))
  })
  assert.deepEqual(accessibility, [])
  await panel.getByRole('button', { name: 'Workspace', exact: true }).click()
  await panel.getByLabel('What should we do?', { exact: true }).fill('Read this page and summarize it.')
  await panel.getByLabel('I approve this task', { exact: false }).check()
  mode = 'hold'
  await panel.getByRole('button', { name: 'Start task' }).click()
  const holdDeadline = Date.now() + 10000
  while (calls === 13 && Date.now() < holdDeadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(calls, 14, 'Stop must interrupt an actual pending model request')
  await panel.getByRole('button', { name: 'Stop task' }).click()
  await panel.getByRole('heading', { name: 'Task result', exact: true }).waitFor({ timeout: 10000 })
  assert.match(await panel.locator('.result').innerText(), /stopped/i)
  await panel.getByRole('button', { name: 'Stop task' }).waitFor({ state: 'hidden', timeout: 10000 })
  mode = 'quota'
  await panel.getByLabel('I approve this task', { exact: false }).check()
  await panel.getByRole('button', { name: 'Start task' }).click()
  await panel.getByText(`${selectedProvider.label} reached a rate limit or quota.`, { exact: false }).waitFor({ timeout: 10000 })
  assert.match(await panel.locator('.result').innerText(), /rate limit or quota/i)
  assert.ok(!(await panel.locator('body').innerText()).includes('test-only-key-never-real'))
  assert.deepEqual(errors, [])
  assert.deepEqual(interceptionErrors, [])
  assert.deepEqual(unexpectedNetwork, [])
  const report = { status: 'passed', browser: context.browser()?.version(), provider, providerLabel: selectedProvider.label, model: selectedProvider.model, endpoint: selectedProvider.endpoint, modelCallsMocked: true, authorizationHeaderVerified: true, noKeyInPromptOrQuery: true, unexpectedNetwork, permissionFixture: 'Temporary manifest copy pregrants only the synthetic localhost origin. Release dist is unchanged; native permission dialog requires manual verification.', flow: ['provider onboarding', 'real Chrome permission check for pregranted fixture', 'non-editable protection', 'navigate', 'fill', 'select', 'press Enter', 'click', 'upload', 'scroll down/up with observed lower-page evidence', 'xlsx', 'pdf', 'docx', 'download', 'Stop during model request', 'quota error', 'no persistent API key', 'accessibility'], savedFiles, errors, accessibility }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {})
    console.log(JSON.stringify({ provider, errors, interceptionErrors, unexpectedNetwork, panelText: await panel.locator('body').innerText().catch(() => '[unavailable]') }))
  }
  throw error
} finally {
  await context.close()
  await new Promise(resolve => server.close(resolve))
}
