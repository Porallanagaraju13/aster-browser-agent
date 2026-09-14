// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { cleanup } from '../src/browser'
import { readAttachments } from '../src/documents'
import { validateSettings } from '../src/provider'
import { runAgent } from '../src/runner'
import { loadSettings } from '../src/settings'
import type { ProviderSettings, RunOptions } from '../src/types'

vi.mock('../src/browser', () => ({ observe: vi.fn(), execute: vi.fn(), cleanup: vi.fn() }))
vi.mock('../src/documents', () => ({ createArtifact: vi.fn(), downloadArtifact: vi.fn(), readAttachments: vi.fn() }))
vi.mock('../src/provider', () => ({ validateSettings: vi.fn((value: ProviderSettings) => value) }))
vi.mock('../src/runner', () => ({ runAgent: vi.fn() }))
vi.mock('../src/settings', async importOriginal => ({
  ...await importOriginal<typeof import('../src/settings')>(),
  loadSettings: vi.fn(), saveSettings: vi.fn(), forgetKey: vi.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function eventSource<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    listeners,
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) }
  }
}

const run = vi.mocked(runAgent)
type TabActivatedInfo = { tabId: number; windowId: number }
type TabRemovedInfo = { windowId: number; isWindowClosing: boolean }
let root: Root
let container: HTMLDivElement
let permission: ReturnType<typeof vi.fn<(...args: [chrome.permissions.Permissions]) => Promise<boolean>>>
let locks: ReturnType<typeof vi.fn<(name: string, options: { ifAvailable: boolean }, callback: (lock: { name: string } | null) => Promise<void>) => Promise<void>>>
let activated: ReturnType<typeof eventSource<[TabActivatedInfo]>>
let removed: ReturnType<typeof eventSource<[number, TabRemovedInfo]>>
let storageChanged: ReturnType<typeof eventSource<[Record<string, chrome.storage.StorageChange>, string]>>

function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text))
  if (!element) throw new Error(`Button not found: ${text}`)
  return element
}
async function click(element: HTMLElement): Promise<void> { await act(async () => { element.click() }) }
async function enterTask(value = 'Read this approved page and summarize its public information.'): Promise<void> {
  const input = container.querySelector('.task-form textarea') as HTMLTextAreaElement
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function approveTask(): Promise<void> {
  await enterTask()
  const approval = container.querySelector('.approval input') as HTMLInputElement
  await click(approval)
  expect(approval.checked).toBe(true)
  expect(button('Start task').disabled).toBe(false)
}
async function startTask(): Promise<void> {
  await approveTask()
  await click(button('Start task'))
}
function holdRunUntilAbort(): { current: RunOptions | undefined } {
  const captured: { current: RunOptions | undefined } = { current: undefined }
  run.mockImplementation(options => {
    captured.current = options
    return new Promise(resolve => {
      const stop = () => resolve({ outcome: 'stopped', summary: 'Task stopped after cancellation.' })
      if (options.signal.aborted) stop()
      else options.signal.addEventListener('abort', stop, { once: true })
    })
  })
  return captured
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  activated = eventSource<[TabActivatedInfo]>()
  removed = eventSource<[number, TabRemovedInfo]>()
  storageChanged = eventSource<[Record<string, chrome.storage.StorageChange>, string]>()
  permission = vi.fn().mockResolvedValue(true)
  locks = vi.fn(async (name, _options, callback) => { await callback({ name }) })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: locks } })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42, windowId: 7, active: true, title: 'Approved example', url: 'https://example.com/page' }]),
      onActivated: activated, onRemoved: removed
    },
    permissions: { request: permission },
    storage: { onChanged: storageChanged }
  })
  vi.mocked(loadSettings).mockResolvedValue({ provider: 'groq', model: 'exact-test-model', apiKey: 'synthetic-test-key' })
  vi.mocked(validateSettings).mockImplementation(value => value)
  vi.mocked(cleanup).mockResolvedValue(undefined)
  vi.mocked(readAttachments).mockResolvedValue([])
  run.mockReset().mockResolvedValue({ outcome: 'completed', summary: 'Observed the public information.' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<App />) })
  expect(container.textContent).toContain('Approved example')
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

describe('task approval and native permission boundary', () => {
  it('requires explicit task approval before enabling Start', async () => {
    await enterTask()
    expect(button('Start task').disabled).toBe(true)
    expect(permission).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('requests the approved origin once and never starts the agent when permission is denied', async () => {
    permission.mockResolvedValue(false)
    await startTask()
    expect(permission).toHaveBeenCalledExactlyOnceWith({ origins: ['https://example.com/*'] })
    expect(locks).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Website access was not granted')
    expect(button('Start task').disabled).toBe(true)
  })

  it('stopping while the native permission request is pending prevents a later grant from starting work', async () => {
    const pending = deferred<boolean>()
    permission.mockReturnValue(pending.promise)
    await startTask()
    expect(run).not.toHaveBeenCalled()
    await click(button('Stop task'))
    await act(async () => { pending.resolve(true); await pending.promise })
    expect(locks).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(container.querySelector('.result')?.textContent).toMatch(/stopped/i)
    expect(button('Start task').disabled).toBe(true)
  })

  it('does not launch duplicate permission requests when the form is submitted again while waiting', async () => {
    const pending = deferred<boolean>()
    permission.mockReturnValue(pending.promise)
    await startTask()
    await act(async () => { container.querySelector('.task-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(permission).toHaveBeenCalledTimes(1)
    await click(button('Stop task'))
    await act(async () => { pending.resolve(true); await pending.promise })
    expect(run).not.toHaveBeenCalled()
  })

  it('starts only after permission resolves and passes exactly the approved task scope', async () => {
    const pending = deferred<boolean>()
    permission.mockReturnValue(pending.promise)
    await startTask()
    expect(run).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(true); await pending.promise })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toMatchObject({
      settings: { provider: 'groq', model: 'exact-test-model' }, maxSteps: 25,
      scope: { tabId: 42, origins: ['https://example.com'], allowSubmit: false, allowSensitive: false, attachments: [] }
    })
    expect(container.querySelector('.result')?.textContent).toContain('Observed the public information')
    expect(cleanup).toHaveBeenCalledWith(42)
  })

  it('does not start a second agent when another panel owns the execution lock', async () => {
    locks.mockImplementation(async (_name, _options, callback) => { await callback(null) })
    await startTask()
    expect(run).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already working in another panel')
  })

  it('does not request website access when provider validation fails and redacts the key in the error', async () => {
    vi.mocked(validateSettings).mockImplementation(() => { throw new Error('Invalid synthetic-test-key configuration') })
    await startTask()
    expect(permission).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('[redacted]')
    expect(container.textContent).not.toContain('synthetic-test-key')
  })
})

describe('permanent cancellation and selected-tab lifecycle', () => {
  it('aborts immediately on tab switch and does not resume after returning to the selected tab', async () => {
    const captured = holdRunUntilAbort()
    await startTask()
    const signal = captured.current!.signal
    expect(signal.aborted).toBe(false)
    await act(async () => { activated.emit({ tabId: 99, windowId: 7 }) })
    expect(signal.aborted).toBe(true)
    await act(async () => { activated.emit({ tabId: 42, windowId: 7 }) })
    expect(signal.aborted).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.result')?.textContent).toMatch(/stopped/i)
    expect(button('Start task').disabled).toBe(true)
  })

  it('does not cancel when Chrome reports activation of the same selected tab', async () => {
    const captured = holdRunUntilAbort()
    await startTask()
    await act(async () => { activated.emit({ tabId: 42, windowId: 7 }) })
    expect(captured.current!.signal.aborted).toBe(false)
    await click(button('Stop task'))
    expect(captured.current!.signal.aborted).toBe(true)
  })

  it('aborts when the approved tab is closed but ignores an unrelated tab being removed', async () => {
    const captured = holdRunUntilAbort()
    await startTask()
    await act(async () => { removed.emit(99, { windowId: 7, isWindowClosing: false }) })
    expect(captured.current!.signal.aborted).toBe(false)
    await act(async () => { removed.emit(42, { windowId: 7, isWindowClosing: false }) })
    expect(captured.current!.signal.aborted).toBe(true)
    expect(container.querySelector('.result')?.textContent).toMatch(/stopped/i)
  })

  it('aborts and cleans up when the panel receives pagehide', async () => {
    const captured = holdRunUntilAbort()
    await startTask()
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    expect(captured.current!.signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledWith(42)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('removes Chrome event listeners and aborts pending work when the panel unmounts', async () => {
    const captured = holdRunUntilAbort()
    await startTask()
    expect(activated.listeners.size).toBe(1)
    expect(removed.listeners.size).toBe(1)
    await act(async () => { root.unmount() })
    expect(captured.current!.signal.aborted).toBe(true)
    expect(activated.listeners.size).toBe(0)
    expect(removed.listeners.size).toBe(0)
    // Keep afterEach's unmount balanced without retaining the application instance.
    root = createRoot(container)
  })
})
