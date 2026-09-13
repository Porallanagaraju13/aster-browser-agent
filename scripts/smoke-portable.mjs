import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, chromium } from 'playwright-core'
import { connectMainInspector, reserveInspectorPort, startPortableBrowserFixture } from './fixtures/portable-browser-fixture.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const portablePath = process.env.ASTER_SMOKE_PORTABLE
  ? path.resolve(process.env.ASTER_SMOKE_PORTABLE)
  : path.join(projectRoot, 'release', `Aster-Browser-Agent-${packageJson.version}-Windows-x64.exe`)
const executablePath = process.env.ASTER_SMOKE_EXECUTABLE
  ? path.resolve(process.env.ASTER_SMOKE_EXECUTABLE)
  : portablePath
const portableWasLaunched = path.relative(portablePath, executablePath) === ''
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'aster-portable-smoke-'))
const environment = { ...process.env, GEMINI_API_KEY: 'smoke-placeholder-not-a-valid-key' }
environment.GEMINI_MODEL = 'gemini-portable-smoke-fixture'
delete environment.OPENROUTER_API_KEY
delete environment.GROQ_API_KEY
delete environment.ELECTRON_RENDERER_URL
delete environment.ELECTRON_RUN_AS_NODE
delete environment.CHROME_PATH
delete environment.NODE_PATH
delete environment.NODE_OPTIONS
for (const name of Object.keys(environment)) {
  if (name.startsWith('PLAYWRIGHT_') || /FFMPEG/i.test(name)) delete environment[name]
}
environment.DOTENV_CONFIG_PATH = path.join(userDataDir, 'no-environment-file')
const unavailableBrowserCache = path.join(userDataDir, 'missing-playwright-cache')
environment.PLAYWRIGHT_BROWSERS_PATH = unavailableBrowserCache
let application
let cdpBrowser
let portableProcess
let portableExited = false
let portableExit
let launchError
let inspectorPort
let inspector
let fixture

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function launchPortable() {
  // The portable bootstrapper does not forward Electron's inspector stderr to Playwright.
  // Attach to Chromium through the port file written inside this exact isolated profile.
  portableProcess = spawn(executablePath, [
    `--user-data-dir=${userDataDir}`,
    `--inspect=127.0.0.1:${inspectorPort}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1'
  ], { cwd: userDataDir, env: environment, windowsHide: true, stdio: 'ignore' })
  portableExit = new Promise((resolve) => {
    portableProcess.once('exit', (code, signal) => {
      portableExited = true
      resolve({ code, signal })
    })
    portableProcess.once('error', (error) => {
      launchError = error
      portableExited = true
      resolve({ error: error.message })
    })
  })

  const deadline = Date.now() + 90_000
  let port
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    if (portableExited) throw new Error(`Portable launcher exited before opening its debugging endpoint: ${JSON.stringify(await portableExit)}`)
    const portFile = await readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')
      .catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
    const candidate = Number(portFile.split(/\r?\n/)[0])
    if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) {
      port = candidate
      break
    }
    await delay(200)
  }
  if (!port) throw new Error('Portable application did not create DevToolsActivePort in its isolated profile within 90 seconds.')
  cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
  while (Date.now() < deadline) {
    const page = cdpBrowser.contexts().flatMap((context) => context.pages())
      .find((candidate) => !candidate.url().startsWith('devtools:'))
    if (page) return page
    await delay(200)
  }
  throw new Error('Portable application started Chromium but did not create an application window.')
}

async function closePortable() {
  if (inspector) await inspector.close().catch(() => undefined)
  if (cdpBrowser) {
    try {
      await Promise.race([(async () => {
        const session = await cdpBrowser.newBrowserCDPSession()
        await session.send('Browser.close')
      })(), delay(3_000)])
    } catch {
      // Browser.close can disconnect before the protocol acknowledgement is delivered.
    }
    await Promise.race([cdpBrowser.close().catch(() => undefined), delay(3_000)])
  }
  if (!portableProcess || portableExited) return
  await Promise.race([portableExit, delay(10_000)])
  if (!portableExited && portableProcess.pid) {
    // Only the process tree created by this smoke test is eligible for forced cleanup.
    const ownedPid = portableProcess.pid
    await Promise.race([new Promise((resolve) => {
      const cleanup = spawn('taskkill.exe', ['/PID', String(ownedPid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore'
      })
      cleanup.once('error', resolve)
      cleanup.once('exit', resolve)
    }), delay(10_000)])
    await Promise.race([portableExit, delay(5_000)])
  }
  if (!portableExited) throw new Error(`The smoke test could not close its owned portable launcher (PID ${portableProcess.pid}).`)
}

async function verifyRecordedBrowserTask(page) {
  const task = `Open ${fixture.origin}/fixture, enter Portable Tester in Display name, click Show greeting, and verify the page shows Hello, Portable Tester.`
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByRole('textbox', { name: 'Browser task' }).fill(task)
  await page.getByRole('button', { name: 'Run agent', exact: true }).click()
  await page.getByRole('heading', { name: 'Approve this browser task?' }).waitFor()
  await page.getByRole('button', { name: 'Approve task', exact: true }).click()

  const artifactsRoot = path.join(userDataDir, 'artifacts')
  const deadline = Date.now() + 120_000
  let runDir
  let terminal
  let events = []
  while (Date.now() < deadline) {
    if (!runDir) {
      const entries = await readdir(artifactsRoot, { withFileTypes: true }).catch(() => [])
      const run = entries.find((entry) => entry.isDirectory())
      if (run) runDir = path.join(artifactsRoot, run.name)
    }
    if (runDir) {
      const log = await readFile(path.join(runDir, 'events.jsonl'), 'utf8').catch(() => '')
      events = log.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      terminal = [...events].reverse().find((event) => ['completed', 'incomplete', 'failed', 'stopped'].includes(event.status))
      if (terminal) break
    }
    await delay(250)
  }
  if (!terminal || terminal.status !== 'completed') {
    const latestError = [...events].reverse().find((event) => event.type === 'error')
    throw new Error(fixture.state.error || terminal?.detail || latestError?.detail || 'Recorded portable browser task did not complete within 120 seconds.')
  }
  if (!fixture.state.verified || fixture.state.enteredName !== 'Portable Tester') {
    throw new Error('The portable task reported completion without the fixture confirming the typed and clicked result.')
  }
  const expectedActions = ['navigate', 'type_text', 'click', 'finish']
  if (expectedActions.some((name) => !fixture.state.actions.includes(name))) {
    throw new Error('The portable task did not execute every required browser action.')
  }
  const videosDir = path.join(runDir, 'videos')
  const videos = []
  for (const filename of await readdir(videosDir)) {
    if (!filename.toLowerCase().endsWith('.webm')) continue
    const bytes = await readFile(path.join(videosDir, filename))
    if (bytes.length < 1_024 || bytes.subarray(0, 4).toString('hex') !== '1a45dfa3' || !bytes.subarray(0, 256).includes(Buffer.from('webm'))) {
      throw new Error('The packaged browser produced an empty or invalid WebM recording.')
    }
    videos.push({ filename, bytes: bytes.length })
  }
  if (!videos.length || !events.some((event) => event.metadata?.kind === 'video')) {
    throw new Error('The recorded browser task did not publish a completed WebM artifact.')
  }
  if (await stat(unavailableBrowserCache).then(() => true, () => false)) {
    throw new Error('The portable smoke test unexpectedly populated its disabled external Playwright cache.')
  }
  return { outcome: terminal.status, actions: fixture.state.actions, localMockProviderRequests: fixture.state.providerRequests, recordings: videos }
}

try {
  fixture = await startPortableBrowserFixture()
  inspectorPort = await reserveInspectorPort()
  let page
  if (portableWasLaunched) {
    page = await launchPortable()
  } else {
    application = await electron.launch({
      executablePath,
      cwd: userDataDir,
      args: [`--user-data-dir=${userDataDir}`],
      env: environment,
      timeout: 90_000
    })
    page = await application.firstWindow({ timeout: 90_000 })
  }
  if (portableWasLaunched) inspector = await connectMainInspector(inspectorPort)
  const evaluateMain = (expression) => inspector
    ? inspector.evaluate(expression)
    : application.evaluate((_electron, source) => globalThis.eval(source), expression)
  const recordingRuntime = await evaluateMain(`(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      return originalFetch(${JSON.stringify(`${fixture.origin}/mock-provider`)}, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: await request.text(), signal: request.signal
      });
    };
    return { browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH, resourcesPath: process.resourcesPath };
  })()`)
  const relativeRuntime = path.relative(recordingRuntime.resourcesPath, recordingRuntime.browsersPath ?? '')
  if (!recordingRuntime.browsersPath || relativeRuntime === '..' || relativeRuntime.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRuntime)) {
    throw new Error('The packaged app did not override the missing external browser cache with its bundled recording runtime.')
  }
  await page.getByText('Aster', { exact: true }).waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Attach files', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Downloads', exact: true }).click()
  await page.getByText('Your downloadable files', { exact: true }).waitFor()
  await page.getByText('No files yet. Ask Aster to create or download a document.', { exact: true }).waitFor()
  const recordedTask = await verifyRecordedBrowserTask(page)
  const file = await readFile(portablePath)
  const info = await stat(portablePath)
  const portableSha256 = createHash('sha256').update(file).digest('hex').toUpperCase()
  console.log(JSON.stringify({
    launchedExecutable: executablePath,
    launchedTarget: portableWasLaunched ? 'portable' : 'explicit override',
    launchedExecutableSha256: portableWasLaunched
      ? portableSha256
      : createHash('sha256').update(await readFile(executablePath)).digest('hex').toUpperCase(),
    portableExecutable: portablePath,
    portableWasLaunched,
    sizeBytes: info.size,
    sha256: portableSha256,
    launched: true,
    uiChecks: ['Attach files available', 'Downloads accessible', 'Fresh profile has no downloads'],
    browserTaskStarted: true,
    providerMode: 'deterministic loopback mock; no external provider requests',
    externalPlaywrightCache: 'missing and unused',
    bundledRecordingRuntime: true,
    recordedTask
  }, null, 2))
} finally {
  try {
    if (application) await application.close().catch(() => undefined)
    await closePortable()
  } finally {
    if (fixture) await fixture.close()
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
  }
}
