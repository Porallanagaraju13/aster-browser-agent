import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const projectRoot = path.resolve(import.meta.dirname, '../..')
const PRIVATE_ENV = /^(?:GEMINI|GOOGLE|OPENROUTER|GROQ|NVIDIA|OPENAI|ANTHROPIC|AZURE_OPENAI|AI_PROVIDER|MODEL_PROVIDER|DOTENV_CONFIG_|ELECTRON_|NODE_|PLAYWRIGHT_|CHROME_PATH|ASTER_)/i
const SECRET_ENV = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

export async function createDesktopTestProfile(label) {
  assert.match(label, /^[a-z0-9-]+$/)
  return mkdtemp(path.join(os.tmpdir(), `aster-${label}-`))
}

export function desktopTestEnvironment(dataDir) {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (PRIVATE_ENV.test(name) || SECRET_ENV.test(name)) delete environment[name]
  }
  // Both cwd and dotenv's explicit target are isolated. No project .env is consulted.
  environment.DOTENV_CONFIG_PATH = path.join(dataDir, 'intentionally-missing.env')
  return environment
}

export function desktopLaunchOptions(dataDir) {
  return { args: ['-r', path.join(projectRoot, 'scripts/fixtures/desktop-network-guard.cjs'), projectRoot, `--user-data-dir=${dataDir}`], cwd: dataDir, env: desktopTestEnvironment(dataDir), timeout: 90_000 }
}

export async function assertDesktopIsolation(application, dataDir, expectedProviderEnvironment = {}) {
  const state = await application.evaluate(({ app }, expected) => ({
    cwd: process.cwd(), userData: app.getPath('userData'), dotenv: process.env.DOTENV_CONFIG_PATH,
    providerVariables: Object.keys(process.env).filter(name => /^(?:GEMINI|GOOGLE|OPENROUTER|GROQ|NVIDIA|OPENAI|ANTHROPIC|AZURE_OPENAI|AI_PROVIDER|MODEL_PROVIDER)/i.test(name)),
    expectedProviderEnvironmentMatches: Object.entries(expected).every(([name, value]) => process.env[name] === value),
    injectedNodeOptions: Boolean(process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.ELECTRON_RENDERER_URL),
    guardInstalled: typeof globalThis.__asterTestNativeFetch === 'function',
    startupNetwork: globalThis.__asterStartupBlockedNetwork
  }), expectedProviderEnvironment)
  assert.equal(path.resolve(state.cwd).toLowerCase(), path.resolve(dataDir).toLowerCase())
  assert.equal(path.resolve(state.userData).toLowerCase(), path.resolve(dataDir).toLowerCase())
  assert.equal(state.dotenv, path.join(dataDir, 'intentionally-missing.env'))
  assert.deepEqual(state.providerVariables.sort(), Object.keys(expectedProviderEnvironment).sort())
  assert.equal(state.expectedProviderEnvironmentMatches, true, 'Only deliberately injected synthetic provider values are permitted')
  assert.equal(state.injectedNodeOptions, false)
  assert.equal(state.guardInstalled, true, 'Fail-closed network guard must load before Aster')
  assert.equal(state.startupNetwork, 0, 'A fresh unconfigured startup must not contact a provider')
}

export async function closeDesktopTest(application, dataDir) {
  if (application) await application.close().catch(() => undefined)
  const actual = await realpath(dataDir)
  const tempRoot = await realpath(os.tmpdir())
  const relative = path.relative(tempRoot, actual)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep), 'Cleanup must target one owned direct temporary directory')
  assert.match(path.basename(actual), /^aster-[a-z0-9-]+-/)
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}

export async function waitForTest(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
