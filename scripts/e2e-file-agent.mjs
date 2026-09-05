import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(import.meta.dirname, '..')
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'aster-file-agent-e2e-'))
const artifactsRoot = path.join(userDataDir, 'artifacts')
let application

async function newestRunDirectory() {
  const entries = await readdir(artifactsRoot, { withFileTypes: true })
  const runs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()
  return runs[0] ? path.join(artifactsRoot, runs[0]) : undefined
}

async function readEvents(runDir) {
  try {
    const body = await readFile(path.join(runDir, 'events.jsonl'), 'utf8')
    return body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

try {
  application = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: { ...process.env },
    timeout: 90_000
  })
  const page = await application.firstWindow()
  await page.getByText('Aster', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Toggle settings' }).click()
  await page.getByRole('button', { name: 'Validate & save' }).click()
  await page.getByText('Google Gemini connected from encrypted local storage.').waitFor({ timeout: 30_000 })
  const credentialFile = await readFile(path.join(userDataDir, 'credentials.json'), 'utf8')
  if (!credentialFile.includes('"encryptedKey"') || credentialFile.includes('"apiKey"')) {
    throw new Error('The production credential store did not contain only encrypted key material.')
  }
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.locator('textarea').fill(
    'Open https://example.com, verify the page heading and purpose, then create a downloadable Word document named example-domain-report.docx with a short title, the verified heading, the page purpose, and the source URL.'
  )
  await page.getByRole('button', { name: /Run agent/i }).click()
  await page.getByRole('heading', { name: 'Approve this browser task?' }).waitFor()
  await page.getByRole('button', { name: 'Approve task' }).click()

  let runDir
  let events = []
  const deadline = Date.now() + 5 * 60 * 1_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000)
    runDir = runDir ?? await newestRunDirectory().catch(() => undefined)
    if (!runDir) continue
    events = await readEvents(runDir)
    const terminal = [...events].reverse().find((event) =>
      event.type === 'status' && ['completed', 'failed', 'stopped'].includes(event.status)
    )
    if (terminal) break
  }

  if (!runDir) throw new Error('The live file test did not create a run directory.')
  const terminal = [...events].reverse().find((event) =>
    event.type === 'status' && ['completed', 'failed', 'stopped'].includes(event.status)
  )
  if (!terminal) throw new Error('The live file test exceeded five minutes.')
  if (terminal.status !== 'completed') {
    const latestError = [...events].reverse().find((event) => event.type === 'error')
    throw new Error(latestError?.detail || `The live agent ended with ${terminal.status}.`)
  }

  const downloadsDir = path.join(runDir, 'downloads')
  const files = await readdir(downloadsDir)
  const documentName = files.find((filename) => filename === 'example-domain-report.docx')
  if (!documentName) throw new Error('The model completed without creating example-domain-report.docx.')
  const document = await readFile(path.join(downloadsDir, documentName))
  if (document.subarray(0, 2).toString() !== 'PK' || document.length < 1_000) {
    throw new Error('The generated Word artifact is not a valid DOCX container.')
  }

  await page.getByRole('button', { name: 'Open Downloadable file' }).waitFor()
  await page.getByRole('button', { name: 'Save Downloadable file as a file' }).waitFor()
  console.log(`PASS live Gemini created ${documentName} (${document.length} bytes)`)
  console.log('PASS live key validation and OS-encrypted credential storage')
  console.log('PASS live artifact Open and Save as controls')
} finally {
  if (application) await application.close().catch(() => undefined)
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
}
