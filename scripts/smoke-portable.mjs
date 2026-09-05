import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, chromium } from 'playwright-core'

const projectRoot = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const portablePath = path.join(
  projectRoot,
  'release',
  `Aster-Browser-Agent-${packageJson.version}-Windows-x64.exe`
)
const executablePath = process.env.ASTER_SMOKE_EXECUTABLE
  ? path.resolve(process.env.ASTER_SMOKE_EXECUTABLE)
  : portablePath
const portableWasLaunched = path.relative(portablePath, executablePath) === ''
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'aster-portable-smoke-'))
const environment = { ...process.env, GEMINI_API_KEY: 'smoke-placeholder-not-a-valid-key' }
delete environment.OPENROUTER_API_KEY
delete environment.GROQ_API_KEY
delete environment.ELECTRON_RENDERER_URL
delete environment.ELECTRON_RUN_AS_NODE
environment.DOTENV_CONFIG_PATH = path.join(userDataDir, 'no-environment-file')
let application
let cdpBrowser
let portableProcess
let portableExited = false
let portableExit
let launchError

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function launchPortable() {
  // The portable bootstrapper does not forward Electron's inspector stderr to Playwright.
  // Attach to Chromium through the port file written inside this exact isolated profile.
  portableProcess = spawn(executablePath, [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1'
  ], { cwd: projectRoot, env: environment, windowsHide: true, stdio: 'ignore' })
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

try {
  let page
  if (portableWasLaunched) {
    page = await launchPortable()
  } else {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDir}`],
      env: environment,
      timeout: 90_000
    })
    page = await application.firstWindow({ timeout: 90_000 })
  }
  await page.getByText('Aster', { exact: true }).waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Attach files', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Downloads', exact: true }).click()
  await page.getByText('Your downloadable files', { exact: true }).waitFor()
  await page.getByText('No files yet. Ask Aster to create or download a document.', { exact: true }).waitFor()
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
    browserTaskStarted: false
  }, null, 2))
} finally {
  if (application) await application.close().catch(() => undefined)
  await closePortable()
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
}
