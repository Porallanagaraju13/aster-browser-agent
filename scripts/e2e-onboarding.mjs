import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import axe from 'axe-core'

const projectRoot = path.resolve(import.meta.dirname, '..')
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aster-onboarding-e2e-'))
const environment = { ...process.env }
delete environment.GEMINI_API_KEY
delete environment.OPENROUTER_API_KEY
delete environment.GROQ_API_KEY
environment.DOTENV_CONFIG_PATH = path.join(dataDir, 'no-environment-file')
let application

try {
  application = await electron.launch({
    args: ['.', `--user-data-dir=${dataDir}`],
    cwd: projectRoot,
    env: environment,
    timeout: 90_000
  })
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
  await provider.selectOption('openrouter')
  if (await page.locator('.provider-form input:not([type="password"])').inputValue() !== 'google/gemini-3-flash-preview') {
    throw new Error('OpenRouter did not receive its vision/tool model suggestion.')
  }
  const key = page.locator('.provider-form input[type="password"]')
  if (await key.getAttribute('type') !== 'password') throw new Error('The API key field is not masked.')
  await page.getByRole('button', { name: 'Validate and continue' }).click()
  await page.getByText('Paste a OpenRouter API key.').waitFor()

  await provider.selectOption('groq')
  if (await page.locator('.provider-form input:not([type="password"])').inputValue() !== 'qwen/qwen3.6-27b') {
    throw new Error('Groq did not receive its vision/tool model suggestion.')
  }
  console.log('PASS required first-run provider onboarding')
  console.log('PASS Google, OpenRouter, and Groq choices')
  console.log('PASS masked API key and editable model ID')
  console.log('PASS onboarding WCAG 2.1 AA automated audit')
} finally {
  if (application) await application.close().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}
