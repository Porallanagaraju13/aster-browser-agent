import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { assertDesktopIsolation, closeDesktopTest, createDesktopTestProfile, desktopLaunchOptions, waitForTest } from './fixtures/desktop-test-isolation.mjs'
import { DESKTOP_PROVIDER_CASES, installDesktopProviderStub, startDesktopProviderFixture } from './fixtures/desktop-provider-fixture.mjs'

async function readRuns(dataDir) {
  const root = path.join(dataDir, 'artifacts')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const runs = []
  for (const entry of entries.filter(item => item.isDirectory())) {
    const directory = path.join(root, entry.name)
    const log = await readFile(path.join(directory, 'events.jsonl'), 'utf8').catch(() => '')
    const events = log.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    runs.push({ directory, log, events })
  }
  return runs
}

async function startTask(page, task) {
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByRole('textbox', { name: 'Browser task' }).fill(task)
  await page.getByRole('button', { name: 'Run agent', exact: true }).click()
  await page.getByRole('heading', { name: 'Approve this browser task?' }).waitFor()
  await page.getByRole('button', { name: 'Approve task', exact: true }).click()
}

const results = []
// Serial execution avoids three Electron/Chrome/video pipelines competing for resources.
for (const provider of Object.keys(DESKTOP_PROVIDER_CASES)) {
  const dataDir = await createDesktopTestProfile(`provider-${provider}-e2e`)
  let application, fixture
  try {
    fixture = await startDesktopProviderFixture(provider)
    application = await electron.launch(desktopLaunchOptions(dataDir))
    await installDesktopProviderStub(application, fixture)
    await assertDesktopIsolation(application, dataDir)
    const page = await application.firstWindow()
    const rendererErrors = []
    page.on('pageerror', error => rendererErrors.push(error.message))
    await page.getByRole('heading', { name: 'Connect your AI provider' }).waitFor()
    if (provider === 'nvidia') {
      // Missing NVIDIA_MODEL must still select the environment key's provider and
      // let the user supply an exact ID without exposing or re-pasting that key.
      await application.evaluate((_electron, key) => {
        process.env.NVIDIA_API_KEY = key
        delete process.env.NVIDIA_MODEL
      }, fixture.key)
      await page.reload()
      await page.getByRole('heading', { name: 'Connect your AI provider' }).waitFor()
      await assertDesktopIsolation(application, dataDir, { NVIDIA_API_KEY: fixture.key })
      assert.equal(await page.locator('.provider-form select').inputValue(), 'nvidia')
      assert.equal(await page.locator('.provider-form input[type="password"]').inputValue(), '', 'Environment key must never enter renderer form fields')
    } else {
      await page.locator('.provider-form select').selectOption(provider)
      await page.locator('.provider-form input[type="password"]').fill(fixture.key)
    }
    const model = page.locator('.provider-form input:not([type="password"])')
    if (provider === 'nvidia') assert.equal(await model.inputValue(), '', 'NVIDIA should not guess a model')
    await model.fill(fixture.model)
    await page.getByRole('button', { name: 'Validate and continue' }).click()
    await page.getByRole('button', { name: 'Run agent', exact: true }).waitFor({ timeout: 25_000 })
    assert.ok(fixture.state.requests.some(request => request.url === fixture.spec.catalog), 'Onboarding did not validate the model catalog')
    assert.ok(fixture.state.requests.every(request => request.method === 'GET'), 'Credential validation must not make an inference request')
    assert.equal(await page.locator('input[type="password"]').count(), 0, 'Onboarding credential form was not dismissed')

    const task = `Open ${fixture.origin}/fixture, enter ${fixture.entered} in Display name, click Show greeting, verify the greeting and create a TXT report with the observed greeting.`
    await startTask(page, task)
    const completed = await waitForTest(async () => {
      if (fixture.state.error) throw new Error(fixture.state.error)
      const runs = await readRuns(dataDir)
      const run = runs.find(item => item.events.some(event => ['completed', 'incomplete', 'failed', 'stopped'].includes(event.status)))
      return run
    }, `${provider} full browser task`, 120_000)
    const terminal = [...completed.events].reverse().find(event => ['completed', 'incomplete', 'failed', 'stopped'].includes(event.status))
    assert.equal(terminal.status, 'completed', `${provider} task did not complete: ${terminal.detail}`)
    assert.equal(fixture.state.verified, true, 'Completion requires actual local page confirmation')
    for (const name of ['navigate', 'type_text', 'click', 'save_file', 'finish']) assert.ok(fixture.state.actions.includes(name), `Missing ${name} action`)
    const relativeArtifact = path.relative(completed.directory, fixture.state.artifactPath)
    assert.ok(relativeArtifact && !relativeArtifact.startsWith('..') && !path.isAbsolute(relativeArtifact), 'Returned artifact must be in the isolated run')
    const artifact = await readFile(fixture.state.artifactPath, 'utf8')
    assert.ok(artifact.includes(`Hello, ${fixture.entered}.`), 'Downloaded report lacks verified data')
    assert.ok(!completed.log.includes(fixture.key), 'Raw provider credential leaked into the run log')
    await page.getByRole('button', { name: 'Downloads', exact: true }).click()
    await page.getByText(`${provider}-verified-report.txt`, { exact: true }).first().waitFor()
    const savedCopy = path.join(dataDir, `${provider}-user-download.txt`)
    await application.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, savedCopy)
    await page.getByRole('button', { name: `Download ${provider}-verified-report.txt`, exact: true }).click()
    const downloaded = await waitForTest(() => readFile(savedCopy, 'utf8').catch(() => ''), `${provider} actual Download save-as copy`)
    assert.equal(downloaded, artifact, 'Download control must save the actual generated file bytes')

    // Catalog success is not inference success: an auth failure must terminate visibly.
    fixture.state.mode = 'failure'
    const firstRunDirectories = new Set((await readRuns(dataDir)).map(run => run.directory))
    await startTask(page, `Open ${fixture.origin}/fixture and verify the heading.`)
    const failed = await waitForTest(async () => {
      if (fixture.state.error) throw new Error(fixture.state.error)
      return (await readRuns(dataDir)).find(run => !firstRunDirectories.has(run.directory) && run.events.some(event => event.status === 'failed'))
    }, `${provider} clear inference failure`, 60_000)
    const failure = [...failed.events].reverse().find(event => event.status === 'failed')
    assert.match(failure.detail ?? '', new RegExp(`${fixture.spec.label}.*(?:401|key|auth|reject)`, 'i'), 'Inference error must identify the provider and actionable authentication problem')
    assert.ok(!failed.log.includes(fixture.key), 'Failure leaked the synthetic provider key')
    assert.equal(fixture.state.failedRequests, 1, 'Authentication failures should not be retried')
    await page.locator('.status-pill').filter({ hasText: /^Failed$/ }).waitFor()
    const visibleFailure = await page.locator('.error-banner').innerText()
    assert.match(visibleFailure, new RegExp(fixture.spec.label, 'i'))
    assert.ok(!visibleFailure.includes(fixture.key), 'Displayed provider failure leaked the key')
    assert.equal(await application.evaluate(() => globalThis.__asterUnexpectedProviderRequests), 0)
    assert.deepEqual(rendererErrors, [])
    results.push({ provider, model: fixture.model, actions: fixture.state.actions, startup: 'UI-only waiting page excluded from semantic model context', artifact: path.basename(fixture.state.artifactPath), inferenceFailure: 'visible and redacted', calls: fixture.state.requests.length })
    console.log(`PASS ${fixture.spec.label}: catalog → isolated browser → navigate/type/click → TXT download; visible redacted inference failure`)
  } finally {
    try { await closeDesktopTest(application, dataDir) } finally { if (fixture) await fixture.close() }
  }
}
console.log(JSON.stringify({ providerMode: 'owned loopback mocks only; no paid model requests', results }, null, 2))
