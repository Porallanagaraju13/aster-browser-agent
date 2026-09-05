import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRunner } from '../src/main/agent-runner'
import type { AgentEvent, ApprovalRequest, PageObservation, StartRunInput } from '../src/shared/types'
import type { PlannerTurn } from '../src/main/planner'

const mocked = vi.hoisted(() => ({ browser: vi.fn(), planner: vi.fn() }))
vi.mock('../src/main/browser-controller', () => ({
  BrowserController: class { constructor(options: unknown) { Object.assign(this, mocked.browser(options)) } }
}))
vi.mock('../src/main/planner', () => ({ createPlanner: mocked.planner }))

const observation: PageObservation = {
  url: 'https://example.com/', title: 'Example', text: 'Example', elements: [],
  screenshotDataUrl: 'data:image/png;base64,aGVsbG8=', screenshotPath: 'unused.png', tabs: [], activeTabId: 't1'
}
const input: StartRunInput = {
  task: 'Read https://example.com/', apiKey: 'fake-test-key', provider: 'google', model: 'test-model',
  maxSteps: 5, allowlist: ['example.com']
}
const finish: PlannerTurn = { responseId: 'r1', message: '', actions: [{
  name: 'finish', callId: 'c1', arguments: { summary: 'Verified the page.', outcome: 'completed' }
}] }

function browserMock() {
  return {
    start: vi.fn(async (): Promise<void> => undefined), close: vi.fn(async () => [] as string[]),
    observe: vi.fn(async () => observation), execute: vi.fn(async () => ({ ok: true, message: 'Done' })),
    enableTaskWideNavigation: vi.fn(), describeElement: vi.fn(async () => undefined),
    describeFocusedElement: vi.fn(async () => undefined), navigationDecision: vi.fn(() => ({ allowed: true }))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const roots: string[] = []
const runners: AgentRunner[] = []
const releases: Array<() => void> = []

async function harness(approve: boolean | null = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aster-lifecycle-test-'))
  roots.push(root)
  const events: AgentEvent[] = []
  const approvals: ApprovalRequest[] = []
  const runner = new AgentRunner({
    artifactsRoot: path.join(root, 'artifacts'), profileDir: path.join(root, 'profile'),
    emitEvent: (event) => events.push(event),
    emitApproval: (request) => {
      approvals.push(request)
      if (approve !== null) runner.resolveApproval(request.id, approve, false)
    },
    emitLiveFrame: () => undefined
  })
  runners.push(runner)
  return { runner, events, approvals }
}

async function terminal(events: AgentEvent[]) {
  await vi.waitFor(() => expect(events.some((event) => ['completed', 'incomplete', 'failed', 'stopped'].includes(event.status ?? ''))).toBe(true))
  return events.filter((event) => event.status).at(-1)!
}

beforeEach(() => {
  mocked.browser.mockReset().mockImplementation(browserMock)
  mocked.planner.mockReset().mockImplementation(() => ({ begin: vi.fn(async () => finish), continue: vi.fn(async () => finish) }))
})

afterEach(async () => {
  releases.splice(0).forEach((release) => release())
  await Promise.all(runners.splice(0).map((runner) => runner.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentRunner isolated lifecycle', () => {
  it('reserves the run before asynchronous setup and rejects concurrent starts', async () => {
    const { runner, approvals } = await harness(null)
    const results = await Promise.all([runner.start(input), runner.start(input)])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)?.error).toContain('running or still stopping')
    await vi.waitFor(() => expect(approvals).toHaveLength(1))
    expect(mocked.browser).not.toHaveBeenCalled()
    await runner.stop()
  })

  it('honors an immediate denial without starting a browser', async () => {
    const { runner, events } = await harness(false)
    await runner.start(input)
    expect((await terminal(events)).status).toBe('stopped')
    expect(mocked.browser).not.toHaveBeenCalled()
    expect(mocked.planner).not.toHaveBeenCalled()
  })

  it('waits for browser startup to settle before releasing a stopped run', async () => {
    const startup = deferred<void>()
    releases.push(() => startup.resolve())
    const browser = browserMock()
    browser.start.mockImplementation(() => startup.promise)
    mocked.browser.mockReturnValue(browser)
    const { runner, events } = await harness()
    await runner.start(input)
    await vi.waitFor(() => expect(browser.start).toHaveBeenCalled())
    const stopping = runner.stop()
    expect((await runner.start(input)).ok).toBe(false)
    expect(browser.close).not.toHaveBeenCalled()
    startup.resolve()
    await stopping
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(mocked.planner).not.toHaveBeenCalled()
    expect(events.filter((event) => event.status).at(-1)?.status).toBe('stopped')
  })

  it('ignores a late response from a stopped run while a new run is active', async () => {
    const oldTurn = deferred<PlannerTurn>()
    const newTurn = deferred<PlannerTurn>()
    releases.push(() => oldTurn.resolve(finish), () => newTurn.resolve(finish))
    const firstBrowser = browserMock()
    const secondBrowser = browserMock()
    mocked.browser.mockReturnValueOnce(firstBrowser).mockReturnValueOnce(secondBrowser)
    mocked.planner
      .mockReturnValueOnce({ begin: vi.fn(() => oldTurn.promise), continue: vi.fn() })
      .mockReturnValueOnce({ begin: vi.fn(() => newTurn.promise), continue: vi.fn() })
    const { runner, events } = await harness()
    const first = await runner.start(input)
    await vi.waitFor(() => expect(mocked.planner).toHaveBeenCalledTimes(1))
    const firstSignal = mocked.planner.mock.calls[0][0].signal as AbortSignal
    await runner.stop()
    expect(firstSignal.aborted).toBe(true)
    expect(firstBrowser.close).toHaveBeenCalledTimes(1)
    const second = await runner.start(input)
    expect(second.ok).toBe(true)
    await vi.waitFor(() => expect(mocked.planner).toHaveBeenCalledTimes(2))
    const oldEventCount = events.filter((event) => event.runId === first.runId).length
    oldTurn.resolve({ responseId: 'late', message: 'Old response', actions: [{ name: 'click', callId: 'late', arguments: { ref: 'e1' } }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(firstBrowser.execute).not.toHaveBeenCalled()
    expect(secondBrowser.execute).not.toHaveBeenCalled()
    expect(secondBrowser.close).not.toHaveBeenCalled()
    expect(events.filter((event) => event.runId === first.runId)).toHaveLength(oldEventCount)
    newTurn.resolve(finish)
    await vi.waitFor(() => expect(events.some((event) => event.runId === second.runId && event.status === 'completed')).toBe(true))
  })

  it('publishes completion only after browser cleanup and rejects starts during cleanup', async () => {
    const cleanup = deferred<string[]>()
    releases.push(() => cleanup.resolve([]))
    const browser = browserMock()
    browser.close.mockImplementation(() => cleanup.promise)
    mocked.browser.mockReturnValue(browser)
    const { runner, events } = await harness()
    await runner.start(input)
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalled())
    expect(events.some((event) => event.status === 'completed')).toBe(false)
    expect((await runner.start(input)).ok).toBe(false)
    cleanup.resolve([])
    expect((await terminal(events)).status).toBe('completed')
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('marks an empty model turn incomplete instead of completing the task', async () => {
    mocked.planner.mockReturnValue({ begin: vi.fn(async () => ({ responseId: 'empty', message: 'I will do it.', actions: [] })), continue: vi.fn() })
    const { runner, events } = await harness()
    await runner.start(input)
    expect((await terminal(events)).status).toBe('incomplete')
    expect(events.some((event) => event.type === 'complete')).toBe(false)
  })

  it('marks the step limit incomplete and does not request another paid turn', async () => {
    const next = vi.fn()
    mocked.planner.mockReturnValue({ begin: vi.fn(async () => ({ responseId: 'r1', message: '', actions: [{ name: 'inspect_page', callId: 'c1', arguments: {} }] })), continue: next })
    const { runner, events } = await harness()
    await runner.start({ ...input, maxSteps: 1 })
    const result = await terminal(events)
    expect(result.status).toBe('incomplete')
    expect(result.detail).toContain('step limit')
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects completion when a requested document was never created', async () => {
    const { runner, events } = await harness()
    await runner.start({ ...input, task: 'Create a downloadable Word document about example.com.' })
    expect((await terminal(events)).status).toBe('incomplete')
    expect(events.some((event) => event.type === 'complete')).toBe(false)
  })
})
