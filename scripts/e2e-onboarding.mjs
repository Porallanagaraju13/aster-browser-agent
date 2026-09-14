import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'
import axe from 'axe-core'
import { assertDesktopIsolation, closeDesktopTest, createDesktopTestProfile, desktopLaunchOptions } from './fixtures/desktop-test-isolation.mjs'

const dataDir = await createDesktopTestProfile('onboarding-e2e')
let application

try {
  application = await electron.launch(desktopLaunchOptions(dataDir))
  await application.evaluate(() => {
    globalThis.__asterUnexpectedNetwork = 0
    globalThis.fetch = async () => { globalThis.__asterUnexpectedNetwork++; throw new Error('Onboarding test blocked an unexpected network request') }
  })
  await assertDesktopIsolation(application, dataDir)
  const page = await application.firstWindow()
  await page.getByRole('heading', { name: 'Connect your AI provider' }).waitFor()
  await page.evaluate(axe.source)
  const accessibility = await page.evaluate(async () => globalThis.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
  }))
  const serious = accessibility.violations.filter((violation) =>
    ['critical', 'serious'].includes(violation.impact ?? '')
  )
  if (serious.length) {
    const detail = serious.flatMap((item) =>
      item.nodes.map((node) => `${item.id}: ${node.target.join(' ')} — ${node.failureSummary}`)
    ).join('\n')
    throw new Error(`Onboarding accessibility violations:\n${detail}`)
  }

  const provider = page.locator('.provider-form select')
  assert.deepEqual(await provider.locator('option').evaluateAll(options => options.map(option => option.value)), ['google', 'openrouter', 'groq', 'nvidia'])
  await provider.selectOption('openrouter')
  const key = page.locator('.provider-form input[type="password"]')
  if (await key.getAttribute('type') !== 'password') throw new Error('The API key field is not masked.')
  await page.getByRole('button', { name: 'Validate and continue' }).click()
  await page.getByText(/Paste an? OpenRouter API key\./).waitFor()

  await provider.selectOption('groq')
  await page.locator('.provider-form input:not([type="password"])').fill('test-groq/exact-model')
  assert.equal(await page.locator('.provider-form input:not([type="password"])').inputValue(), 'test-groq/exact-model')
  await provider.selectOption('nvidia')
  const model = page.locator('.provider-form input:not([type="password"])')
  assert.equal(await model.inputValue(), '', 'NVIDIA must require an exact user-provided model ID, not a guessed default')
  await model.fill('test-nvidia/exact-model')
  assert.equal(await model.inputValue(), 'test-nvidia/exact-model')
  assert.equal(await application.evaluate(() => globalThis.__asterUnexpectedNetwork), 0)
  console.log('PASS required first-run provider onboarding')
  console.log('PASS Google, OpenRouter, Groq and NVIDIA choices')
  console.log('PASS NVIDIA empty default and exact editable model ID')
  console.log('PASS isolated profile/cwd, scrubbed provider environment and no network calls')
  console.log('PASS masked API key and editable model ID')
  console.log('PASS onboarding WCAG 2.1 AA automated audit')
} finally {
  await closeDesktopTest(application, dataDir)
}
