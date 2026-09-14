import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type Dependencies = { delay?: (milliseconds: number) => Promise<unknown>; onRetry?: (attempt: number, milliseconds: number) => void }
type ResourceModule = { editWindowsResources: (options: { file: string; [key: string]: unknown }) => Promise<unknown> }
const { RETRY_DELAYS_MS, retryResourceEdit, installResourceEditRetry } = require('../scripts/package-windows.cjs') as {
  RETRY_DELAYS_MS: readonly number[]
  retryResourceEdit: (operation: () => Promise<unknown>, file: string, expectedFile: string, dependencies?: Dependencies) => Promise<unknown>
  installResourceEditRetry: (module: ResourceModule, expectedFile: string, dependencies?: Dependencies) => () => void
}

const expected = path.resolve('fixture-packaging', 'release', 'win-unpacked', 'Aster Browser Agent.exe')
const busy = (extra: Record<string, unknown> = {}): Error => Object.assign(new Error('Fixture executable is busy'), {
  code: 'EBUSY', syscall: 'open', path: expected, ...extra
})

describe('bounded Windows executable resource packaging retry', () => {
  it('does not run a build or load the editor when the helper module is imported', () => {
    const loadedBuildModules = Object.keys(require.cache).filter((file) => /[/\\](electron-builder|app-builder-lib)[/\\]/.test(file))
    expect(loadedBuildModules).toEqual([])
  })

  it('returns a successful operation directly without a retry or delay', async () => {
    const operation = vi.fn(async () => 'generated-resource-result')
    const delay = vi.fn(async () => undefined)
    await expect(retryResourceEdit(operation, expected, expected, { delay })).resolves.toBe('generated-resource-result')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })

  it('retries a temporary exact-target open failure and preserves the result', async () => {
    const operation = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce('done')
    const delay = vi.fn(async () => undefined)
    const onRetry = vi.fn()
    await expect(retryResourceEdit(operation, expected, expected, { delay, onRetry })).resolves.toBe('done')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledExactlyOnceWith(1000)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(1, 1000)
  })

  it('stops after three bounded retries and rethrows the original failure', async () => {
    const error = busy()
    const operation = vi.fn(async () => { throw error })
    const delay = vi.fn(async (_milliseconds: number) => undefined)
    await expect(retryResourceEdit(operation, expected, expected, { delay })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(4)
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual(RETRY_DELAYS_MS)
    expect(RETRY_DELAYS_MS).toEqual([1000, 2000, 4000])
    expect(Object.isFrozen(RETRY_DELAYS_MS)).toBe(true)
  })

  it.each([
    ['different error', { code: 'EACCES' }],
    ['partial write syscall', { syscall: 'write' }],
    ['reported partial write', { bytesWritten: 1 }],
    ['unknown write progress', { bytesWritten: '1' }],
    ['different executable', { path: path.join(path.dirname(expected), 'Other.exe') }],
    ['icon input', { path: path.resolve('build', 'icon.ico') }],
    ['missing syscall', { syscall: undefined }],
    ['missing path', { path: undefined }]
  ])('does not retry %s', async (_label, details) => {
    const error = busy(details)
    const operation = vi.fn(async () => { throw error })
    const delay = vi.fn(async () => undefined)
    await expect(retryResourceEdit(operation, expected, expected, { delay })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })

  it('does not retry an operation whose selected target differs from the approved executable', async () => {
    const error = busy()
    const operation = vi.fn(async () => { throw error })
    const delay = vi.fn(async () => undefined)
    await expect(retryResourceEdit(operation, path.resolve('Other.exe'), expected, { delay })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })

  it('wraps only the editor, preserves options and receiver, and restores the original export', async () => {
    const options = { file: expected, iconPath: 'fixture-icon.ico', versionStrings: { ProductName: 'Aster' }, requestedExecutionLevel: 'asInvoker' }
    const observed: unknown[] = []
    const original = vi.fn(async function (this: unknown, value: typeof options) {
      observed.push({ receiver: this, options: value })
      if (observed.length === 1) throw busy()
      return 'preserved'
    })
    const module = { editWindowsResources: original } as unknown as ResourceModule
    const restore = installResourceEditRetry(module, expected, { delay: async () => undefined })
    expect(module.editWindowsResources).not.toBe(original)
    await expect(module.editWindowsResources(options)).resolves.toBe('preserved')
    expect(observed).toEqual([{ receiver: module, options }, { receiver: module, options }])
    expect(original.mock.calls[0][0]).toBe(options)
    expect(original.mock.calls[1][0]).toBe(options)
    restore()
    expect(module.editWindowsResources).toBe(original)
  })
})
