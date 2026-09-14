const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000])

function isRetryableResourceOpenError(error, file, expectedFile) {
  // Only an unsuccessful open is safe to repeat. Never retry a partial write,
  // a different executable/icon, a missing path, or a different error code.
  if (!error || error.code !== 'EBUSY' || error.syscall !== 'open' ||
      typeof error.path !== 'string' || typeof file !== 'string' ||
      typeof expectedFile !== 'string' || !path.isAbsolute(expectedFile) ||
      (error.bytesWritten !== undefined && error.bytesWritten !== 0)) return false
  return path.resolve(file) === expectedFile && path.resolve(error.path) === expectedFile
}

async function retryResourceEdit(operation, file, expectedFile, dependencies = {}) {
  const wait = dependencies.delay ?? delay
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryableResourceOpenError(error, file, expectedFile)) throw error
      const milliseconds = RETRY_DELAYS_MS[attempt]
      dependencies.onRetry?.(attempt + 1, milliseconds)
      await wait(milliseconds)
    }
  }
}

function installResourceEditRetry(resourceModule, expectedFile, dependencies = {}) {
  const original = resourceModule.editWindowsResources
  if (typeof original !== 'function') throw new Error('Installed electron-builder resource editor is unavailable; packaging was not started.')
  const wrapped = function (options) {
    return retryResourceEdit(() => original.call(this, options), options.file, expectedFile, dependencies)
  }
  resourceModule.editWindowsResources = wrapped
  return () => {
    if (resourceModule.editWindowsResources === wrapped) resourceModule.editWindowsResources = original
  }
}

async function packageWindows(projectRoot = path.resolve(__dirname, '..')) {
  if (process.platform !== 'win32') throw new Error('Build the portable Windows application on Windows.')
  const expectedFile = path.resolve(projectRoot, 'release', 'win-unpacked', 'Aster Browser Agent.exe')
  // This is an in-process, project-local wrapper around the installed editor.
  // It does not patch node_modules or alter ASAR integrity, fuses, icon metadata,
  // resource generation, signing configuration, or security software.
  const resourceModule = require('app-builder-lib/out/util/resEdit')
  const restore = installResourceEditRetry(resourceModule, expectedFile, {
    onRetry: (attempt, milliseconds) => console.warn(
      `Windows executable resource open is temporarily busy; retry ${attempt}/${RETRY_DELAYS_MS.length} in ${milliseconds} ms.`
    )
  })
  try {
    const { build } = require('electron-builder')
    // An empty Windows target list uses the configured portable x64 target.
    // Packaging itself must never auto-publish or retry a whole build.
    return await build({ projectDir: projectRoot, win: [], publish: 'never' })
  } finally {
    restore()
  }
}

module.exports = { RETRY_DELAYS_MS, isRetryableResourceOpenError, retryResourceEdit, installResourceEditRetry, packageWindows }

if (require.main === module) {
  packageWindows().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
