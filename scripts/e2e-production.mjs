import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'
import axe from 'axe-core'
import { assertDesktopIsolation, closeDesktopTest, createDesktopTestProfile, desktopLaunchOptions, waitForTest } from './fixtures/desktop-test-isolation.mjs'

async function assertAccessible(page, state) {
  if (!await page.evaluate(() => Boolean(globalThis.axe))) {
    await page.evaluate(axe.source)
  }
  const results = await page.evaluate(async () => globalThis.axe.run(document, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
    }
  }))
  const violations = results.violations.filter((violation) =>
    ['critical', 'serious'].includes(violation.impact ?? '')
  )
  if (violations.length) {
    const summary = violations.map((violation) => {
      const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ')
      return `${violation.id} (${violation.impact}): ${targets}`
    })
    throw new Error(`Accessibility violations in ${state}:\n${summary.join('\n')}`)
  }
}

const dataDir = await createDesktopTestProfile('production-e2e')
const rendererErrors = []
let application

try {
  application = await electron.launch(desktopLaunchOptions(dataDir))
  // Keep model work pending so preview/Stop can be checked without a paid provider call.
  await application.evaluate(() => {
    globalThis.__asterNetwork = { blocked: 0, inference: 0, initialObservation: undefined }
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.headers.get('authorization') !== 'Bearer fixture-openrouter-never-real') {
        globalThis.__asterNetwork.blocked++
        throw new Error('Test blocked unexpected authentication')
      }
      if (request.method === 'GET' && request.url === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { is_free_tier: true } })
      if (request.method === 'GET' && request.url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [{ id: 'fixture/text-tool-model', supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } }] })
      if (request.method !== 'POST' || request.url !== 'https://openrouter.ai/api/v1/chat/completions') {
        globalThis.__asterNetwork.blocked++
        throw new Error('Test blocked an unexpected network request')
      }
      const payload = await request.json()
      globalThis.__asterNetwork.inference++
      const observations = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text))
      const observed = observations.find(text => text.startsWith('CURRENT BROWSER OBSERVATION:'))
      if (observed) globalThis.__asterNetwork.initialObservation = JSON.parse(observed.slice(observed.indexOf('\n') + 1))
      return new Promise((_resolve, reject) => {
        const signal = request.signal
        if (signal.aborted) reject(new Error('Stopped test request'))
        else signal.addEventListener('abort', () => reject(new Error('Stopped test request')), { once: true })
      })
    }
  })
  await assertDesktopIsolation(application, dataDir)
  const page = await application.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })

  await page.getByRole('heading', { name: 'Connect your AI provider' }).waitFor()
  await page.locator('.provider-form select').selectOption('openrouter')
  await page.locator('.provider-form input[type="password"]').fill('fixture-openrouter-never-real')
  await page.locator('.provider-form input:not([type="password"])').fill('fixture/text-tool-model')
  await page.getByRole('button', { name: 'Validate and continue' }).click()
  await page.getByRole('button', { name: 'Run agent', exact: true }).waitFor()
  await assertAccessible(page, 'initial view')
  const settingsButton = page.getByRole('button', { name: 'Toggle settings' })
  // Onboarding used pointer input. Reach Settings with an actual keyboard action,
  // since programmatic focus alone correctly does not activate :focus-visible.
  let keyboardReachedSettings = false
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.keyboard.press('Tab')
    if (await settingsButton.evaluate(element => element === document.activeElement)) {
      keyboardReachedSettings = true
      break
    }
  }
  assert.equal(keyboardReachedSettings, true, 'Settings must be keyboard reachable')
  const focusVisible = await settingsButton.evaluate((element) =>
    getComputedStyle(element).outlineStyle !== 'none'
  )
  if (!focusVisible) throw new Error('Keyboard focus indicator is not visible.')
  await page.keyboard.press('Enter')
  await page.locator('#run-settings').waitFor()
  await assertAccessible(page, 'settings view')
  assert.deepEqual(await page.locator('.settings-sheet select option').evaluateAll(options => options.map(option => option.value)), ['google', 'openrouter', 'groq', 'nvidia'])
  if (await page.getByText('Show Chrome', { exact: true }).count()) {
    throw new Error('Chrome visibility must be automatic rather than controlled by a stale setting.')
  }
  await page.keyboard.press('Escape')
  await page.locator('#run-settings').waitFor({ state: 'detached' })

  const task = page.locator('textarea')
  if (await task.getAttribute('maxlength') !== '2000') {
    throw new Error('Task input is missing its production length bound.')
  }
  await task.fill('Open https://example.com and verify the heading.')
  await page.getByRole('button', { name: /Run agent/i }).click()
  await page.getByRole('heading', { name: 'Approve this browser task?' }).waitFor()
  await assertAccessible(page, 'approval dialog')
  if (!await page.getByRole('button', { name: 'Deny' }).evaluate((button) => button === document.activeElement)) {
    throw new Error('Approval dialog did not place focus on the safe Deny action.')
  }
  await page.keyboard.press('Escape')
  await page.getByText('Task stopped', { exact: true }).first().waitFor()

  await page.getByRole('button', { name: /Run agent/i }).waitFor()
  await page.getByRole('button', { name: /Run agent/i }).click()
  await page.getByRole('button', { name: 'Approve task' }).click()
  await page.locator('.live-chip.active').waitFor({ timeout: 20_000 })
  await page.waitForFunction(
    () => /^data:image\/(?:png|jpeg);base64,/.test(
      document.querySelector('.viewport img')?.getAttribute('src') ?? ''
    ),
    undefined,
    { timeout: 10_000 }
  )
  await page.getByRole('button', { name: 'Open Screenshot 1' }).waitFor()
  await page.getByRole('button', { name: 'Save Screenshot 1 as a file' }).waitFor()
  const initial = await waitForTest(() => application.evaluate(() => globalThis.__asterNetwork.initialObservation), 'initial model observation')
  // The branded local waiting page is visible in the screenshot but intentionally
  // omitted from semantic model context, so it cannot be mistaken for website data.
  assert.equal(initial.url, 'about:blank')
  assert.equal(initial.title, '')
  assert.equal(initial.visibleText, '')
  assert.deepEqual(initial.interactiveElements, [])
  const idlePreview = await page.locator('.viewport img').getAttribute('src')
  assert.ok(idlePreview.length > 1_000, 'Initial waiting-page screenshot must contain actual image bytes')
  await page.waitForTimeout(1_200)
  if (await page.locator('.viewport img').getAttribute('src') !== idlePreview) {
    throw new Error('Idle browser preview changed without an observation or cursor action.')
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.locator('.status-pill').filter({ hasText: /^Stopped$/ }).waitFor()

  const network = await application.evaluate(() => ({ blocked: globalThis.__asterNetwork.blocked, inference: globalThis.__asterNetwork.inference }))
  assert.equal(network.blocked, 0)
  assert.equal(network.inference, 1, 'Stop must not retry a pending model request')
  if (rendererErrors.length) throw new Error(rendererErrors.join('\n'))
  console.log('PASS automatic visible-browser setting')
  console.log('PASS bounded task input')
  console.log('PASS approve, deny and Stop lifecycle (model network stubbed)')
  console.log('PASS embedded verified browser view')
  console.log('PASS stable idle browser preview')
  console.log('PASS visible startup screenshot, local waiting text excluded from semantic model context, fail-closed provider stub')
  console.log('PASS downloadable artifact controls')
  console.log('PASS renderer error monitor')
  console.log('PASS WCAG 2.1 AA automated audit')
  console.log('PASS keyboard focus and Escape behavior')
} finally {
  await closeDesktopTest(application, dataDir)
}
