import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import axe from 'axe-core'

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

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aster-production-e2e-'))
const rendererErrors = []
let application

try {
  application = await electron.launch({
    args: ['.', `--user-data-dir=${dataDir}`],
    env: { ...process.env, GEMINI_API_KEY: 'e2e-placeholder-key' },
    timeout: 90_000
  })
  const page = await application.firstWindow()
  // Keep model work pending so preview/Stop can be checked without a paid provider call.
  await application.evaluate(() => {
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) reject(new Error('Stopped test request'))
      else signal?.addEventListener('abort', () => reject(new Error('Stopped test request')), { once: true })
    })
  })
  page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })

  await page.getByText('Aster', { exact: true }).waitFor()
  await assertAccessible(page, 'initial view')
  const settingsButton = page.getByRole('button', { name: 'Toggle settings' })
  await settingsButton.focus()
  const focusVisible = await settingsButton.evaluate((element) =>
    getComputedStyle(element).outlineStyle !== 'none'
  )
  if (!focusVisible) throw new Error('Keyboard focus indicator is not visible.')
  await page.keyboard.press('Enter')
  await page.locator('#run-settings').waitFor()
  await assertAccessible(page, 'settings view')
  await page.locator('.settings-sheet select').selectOption('google')
  if (await page.locator('.settings-sheet select option').count() !== 3) {
    throw new Error('Settings must expose Google, OpenRouter, and Groq.')
  }
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
  const idlePreview = await page.locator('.viewport img').getAttribute('src')
  await page.waitForTimeout(1_200)
  if (await page.locator('.viewport img').getAttribute('src') !== idlePreview) {
    throw new Error('Idle browser preview changed without an observation or cursor action.')
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.locator('.status-pill').filter({ hasText: /^Stopped$/ }).waitFor()

  if (rendererErrors.length) throw new Error(rendererErrors.join('\n'))
  console.log('PASS automatic visible-browser setting')
  console.log('PASS bounded task input')
  console.log('PASS approve, deny and Stop lifecycle (model network stubbed)')
  console.log('PASS embedded verified browser view')
  console.log('PASS stable idle browser preview')
  console.log('PASS downloadable artifact controls')
  console.log('PASS renderer error monitor')
  console.log('PASS WCAG 2.1 AA automated audit')
  console.log('PASS keyboard focus and Escape behavior')
} finally {
  if (application) await application.close().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}
