const path = require('node:path')
const { readFile, stat } = require('node:fs/promises')
const { spawn } = require('node:child_process')

async function verifyRuntime(runtimeRoot, descriptors) {
  const ffmpeg = descriptors.find((entry) => entry.name === 'ffmpeg')
  const winldd = descriptors.find((entry) => entry.name === 'winldd')
  if (!ffmpeg || !winldd || !/^\d+$/.test(ffmpeg.revision) || !/^\d+$/.test(winldd.revision)) {
    throw new Error('Cannot determine the recording runtime revisions from the installed Playwright package.')
  }
  const files = [
    path.join(runtimeRoot, `ffmpeg-${ffmpeg.revision}`, 'ffmpeg-win64.exe'),
    path.join(runtimeRoot, `ffmpeg-${ffmpeg.revision}`, 'COPYING.LGPLv2.1'),
    path.join(runtimeRoot, `winldd-${winldd.revision}`, 'PrintDeps.exe')
  ]
  for (const file of files) {
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`The portable recording runtime is missing or empty: ${file}. Re-run packaging with network access.`)
    }
    if (file.endsWith('.exe')) {
      const executable = await readFile(file)
      if (executable.toString('ascii', 0, 2) !== 'MZ') {
        throw new Error(`The portable recording runtime is not a Windows executable: ${file}`)
      }
    }
  }
  return files
}

async function prepareRuntime(context) {
  // This distribution is Windows x64 only; never accidentally ship a host's
  // Linux/macOS binaries when electron-builder is used for cross-compilation.
  if (process.platform !== 'win32' || context.electronPlatformName !== 'win32' || context.arch !== 1) {
    throw new Error('Build the portable Windows x64 application on Windows with the x64 target.')
  }
  const projectRoot = context.packager.projectDir
  const playwrightRoot = path.dirname(require.resolve('playwright-core/package.json', { paths: [projectRoot] }))
  const { browsers } = JSON.parse(await readFile(path.join(playwrightRoot, 'browsers.json'), 'utf8'))
  const runtimeRoot = path.join(projectRoot, 'build', 'playwright-runtime')

  // Use the lockfile-installed CLI and its pinned revisions, not npx's latest
  // release or any binary from the developer's global ms-playwright cache.
  await new Promise((resolve, reject) => {
    const installer = spawn(process.execPath, [path.join(playwrightRoot, 'cli.js'), 'install', 'ffmpeg'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: runtimeRoot,
        PLAYWRIGHT_SKIP_BROWSER_GC: '1'
      },
      windowsHide: true,
      stdio: 'inherit'
    })
    installer.once('error', reject)
    installer.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Playwright recording runtime installation failed (exit ${code}).`)))
  })
  await verifyRuntime(runtimeRoot, browsers)
  console.log('Verified bundled Playwright FFmpeg, Windows helper, and license notice.')
}

module.exports = prepareRuntime
module.exports.verifyRuntime = verifyRuntime
