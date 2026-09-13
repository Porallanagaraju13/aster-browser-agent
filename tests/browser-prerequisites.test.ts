import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserController } from '../src/main/browser-controller'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  stat: vi.fn()
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const regularFile = { isFile: () => true } as Stats
const directory = { isFile: () => false } as Stats

function findBrowser(): Promise<string | undefined> {
  const controller = new BrowserController({
    profileDir: 'unused', artifactDir: 'unused', allowlist: [], onNotice: () => undefined
  })
  return (controller as unknown as { findChromeExecutable(): Promise<string | undefined> }).findChromeExecutable()
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  vi.stubEnv('CHROME_PATH', '')
  vi.stubEnv('PROGRAMFILES', 'C:\\Fixture\\Program Files')
  vi.stubEnv('PROGRAMFILES(X86)', 'C:\\Fixture\\Program Files (x86)')
  vi.stubEnv('LOCALAPPDATA', 'C:\\Fixture\\Local')
  vi.mocked(stat).mockReset()
  vi.mocked(stat).mockRejectedValue(Object.assign(new Error('Not found'), { code: 'ENOENT' }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.mocked(stat).mockReset()
})

describe('browser prerequisites', () => {
  it('accepts an existing regular file specified by CHROME_PATH', async () => {
    const browserPath = 'C:\\Custom Browser\\chrome.exe'
    vi.stubEnv('CHROME_PATH', browserPath)
    vi.mocked(stat).mockResolvedValue(regularFile)
    await expect(findBrowser()).resolves.toBe(browserPath)
    expect(stat).toHaveBeenCalledWith(browserPath)
  })

  it('reports a missing or inaccessible configured browser without suggesting developer commands', async () => {
    vi.stubEnv('CHROME_PATH', 'C:\\Missing\\chrome.exe')
    await expect(findBrowser()).rejects.toThrow('CHROME_PATH does not point to an accessible browser file')
    await expect(findBrowser()).rejects.toThrow('restart Aster')
  })

  it('rejects a directory supplied as CHROME_PATH', async () => {
    vi.stubEnv('CHROME_PATH', 'C:\\Custom Browser')
    vi.mocked(stat).mockResolvedValue(directory)
    await expect(findBrowser()).rejects.toThrow('full path of chrome.exe')
  })

  it('finds a per-user Chrome install after missing or invalid machine locations', async () => {
    const browserPath = path.join(process.env.LOCALAPPDATA!, 'Google', 'Chrome', 'Application', 'chrome.exe')
    vi.mocked(stat).mockImplementation(async (candidate) =>
      String(candidate) === browserPath ? regularFile : directory
    )
    await expect(findBrowser()).resolves.toBe(browserPath)
  })

  it('gives Windows users an install-and-restart instruction when Chrome is absent', async () => {
    await expect(findBrowser()).rejects.toThrow('Install Google Chrome from https://www.google.com/chrome/ and restart Aster')
  })

  it('retains the existing channel fallback on other operating systems', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })
    await expect(findBrowser()).resolves.toBeUndefined()
  })
})
