import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextAction, ProviderError } from '../src/provider'
import { runAgent, RUN_LIMITS } from '../src/runner'
import type { Action, AgentDependencies, Observation, RunOptions } from '../src/types'

vi.mock('../src/provider', async importOriginal => ({ ...await importOriginal<typeof import('../src/provider')>(), nextAction: vi.fn() }))
const next = vi.mocked(nextAction)

function fixture(task = 'Search for MrBeast'): { options: RunOptions; deps: AgentDependencies; controller: AbortController; observation: Observation } {
  const controller = new AbortController()
  const observation: Observation = {
    tabId: 10, url: 'https://example.com', title: 'Search', text: 'Search results: MrBeast', elements: [
      { ref: 'e1', tag: 'input', role: 'textbox', name: 'Search', type: 'search', editable: true, disabled: false, sensitive: false },
      { ref: 'e2', tag: 'a', role: 'link', name: 'YouTube Home', editable: false, disabled: false, sensitive: false },
      { ref: 'e3', tag: 'input', role: 'textbox', name: 'Password', type: 'password', editable: true, disabled: false, sensitive: true },
      { ref: 'e4', tag: 'input', role: 'button', name: 'Upload', type: 'file', editable: false, disabled: false, sensitive: false }
    ]
  }
  return {
    controller, observation,
    options: { task, settings: { provider: 'groq', model: 'supplied-model', apiKey: 'private-test-provider-key' }, scope: { tabId: 10, origins: ['https://example.com'], allowSubmit: false, allowSensitive: false, attachments: [] }, maxSteps: 10, signal: controller.signal, onEvent: vi.fn(), onArtifact: vi.fn() },
    deps: { observe: vi.fn().mockResolvedValue(observation), execute: vi.fn().mockResolvedValue({ ok: true, message: 'Action completed' }), createArtifact: vi.fn().mockResolvedValue({ id: 'file1', name: 'results.xlsx', mime: 'application/octet-stream', size: 4, blob: new Blob(['data']) }) }
  }
}
const finish: Action = { type: 'finish', outcome: 'completed', summary: 'Observed the requested result.' }
beforeEach(() => { next.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('bounded browser agent loop', () => {
  it('observes before every action and verifies once more before completion', async () => {
    const { options, deps } = fixture()
    next.mockResolvedValueOnce({ type: 'fill', ref: 'e1', text: 'MrBeast' }).mockResolvedValueOnce(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'completed' })
    expect(deps.observe).toHaveBeenCalledTimes(3)
    expect(deps.execute).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.observe).mock.invocationCallOrder[0]).toBeLessThan(next.mock.invocationCallOrder[0])
    expect(vi.mocked(deps.observe).mock.invocationCallOrder[1]).toBeGreaterThan(vi.mocked(deps.execute).mock.invocationCallOrder[0])
    expect(JSON.stringify(vi.mocked(options.onEvent).mock.calls)).not.toContain('MrBeast')
  })
  it.each([
    { type: 'fill', ref: 'e2', text: 'MrBeast' },
    { type: 'click', ref: 'stale' },
    { type: 'fill', ref: 'e3', text: 'password123' },
    { type: 'navigate', url: 'https://unapproved.example/path' },
    { type: 'press', ref: 'e1', key: 'Enter' },
    { type: 'upload', ref: 'e4', attachmentIds: ['not-approved'] },
    { type: 'fill', ref: 'e1', text: 'private-test-provider-key' }
  ] as Action[])('blocks unsafe action %# without executing it', async action => {
    const { options, deps } = fixture()
    next.mockResolvedValue(action)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'incomplete' })
    expect(deps.execute).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(vi.mocked(options.onEvent).mock.calls)).not.toContain('private-test-provider-key')
  })
  it('refreshes references after an action instead of reusing the old map', async () => {
    const { options, deps, observation } = fixture()
    vi.mocked(deps.observe).mockResolvedValueOnce(observation).mockResolvedValue({ ...observation, elements: [] })
    next.mockResolvedValueOnce({ type: 'click', ref: 'e2' }).mockResolvedValue({ type: 'click', ref: 'e2' })
    await runAgent(options, deps)
    expect(deps.execute).toHaveBeenCalledTimes(1)
  })
  it('stops immediately after cancellation even if a provider ignores abort', async () => {
    const { options, deps, controller } = fixture()
    let resolveAction!: (action: Action) => void
    next.mockImplementation(() => new Promise(resolve => { resolveAction = resolve }))
    const operation = runAgent(options, deps)
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await operation).toMatchObject({ outcome: 'stopped' })
    resolveAction({ type: 'click', ref: 'e2' })
    await Promise.resolve()
    expect(deps.execute).not.toHaveBeenCalled()
  })
  it('starts no work for a pre-aborted task', async () => {
    const { options, deps, controller } = fixture(); controller.abort()
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'stopped' })
    expect(deps.observe).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
  it('stops after the configured step limit and caps excessive settings', async () => {
    const { options, deps } = fixture(); options.maxSteps = 2
    next.mockResolvedValue({ type: 'inspect' })
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'incomplete', summary: expect.stringContaining('2-step') })
    expect(next).toHaveBeenCalledTimes(2)
    next.mockClear(); options.maxSteps = 10000
    await runAgent(options, deps)
    expect(next).toHaveBeenCalledTimes(RUN_LIMITS.maxSteps)
  })
  it('stops a hanging browser operation at the wall-clock deadline', async () => {
    vi.useFakeTimers()
    const { options, deps } = fixture()
    vi.mocked(deps.observe).mockReturnValue(new Promise(() => undefined))
    const operation = runAgent(options, deps)
    await vi.advanceTimersByTimeAsync(RUN_LIMITS.maxDurationMs)
    expect(await operation).toMatchObject({ outcome: 'incomplete', summary: expect.stringContaining('8-minute') })
    expect(next).not.toHaveBeenCalled()
  })
  it('does not retry billable provider errors', async () => {
    const { options, deps } = fixture()
    next.mockRejectedValue(new ProviderError('The provider reached its quota.'))
    expect(await runAgent(options, deps)).toEqual({ outcome: 'incomplete', summary: 'The provider reached its quota.' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(deps.execute).not.toHaveBeenCalled()
  })
  it('does not expose raw browser exceptions in progress or results', async () => {
    const { options, deps } = fixture()
    next.mockResolvedValue({ type: 'click', ref: 'e2' })
    vi.mocked(deps.execute).mockRejectedValue(new Error('password=mysecret private-test-provider-key ?token=secret'))
    const result = await runAgent(options, deps)
    expect(result.outcome).toBe('incomplete')
    expect(JSON.stringify([result, vi.mocked(options.onEvent).mock.calls])).not.toMatch(/mysecret|private-test-provider-key|token=secret/)
    expect(deps.execute).toHaveBeenCalledTimes(3)
  })
  it('does not accept completion after leaving the approved origin', async () => {
    const { options, deps, observation } = fixture()
    vi.mocked(deps.observe).mockResolvedValueOnce(observation).mockResolvedValue({ ...observation, url: 'https://elsewhere.example' })
    next.mockResolvedValue(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'incomplete' })
  })
})

describe('requested downloads', () => {
  it('creates the real requested artifact before completing', async () => {
    const { options, deps } = fixture('Provide the contacts in an Excel sheet')
    next.mockResolvedValueOnce(finish).mockResolvedValueOnce({ type: 'save_spreadsheet', filename: 'contacts.xlsx', columns: ['Name'], rows: [['Observed name']] }).mockResolvedValueOnce(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'completed' })
    expect(options.onArtifact).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(3)
    expect(deps.execute).not.toHaveBeenCalled()
  })
  it('does not claim completion for a promised but missing file', async () => {
    const { options, deps } = fixture('I need a downloadable PDF report')
    next.mockResolvedValue({ type: 'finish', outcome: 'completed', summary: 'I created your file.' })
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'incomplete', summary: expect.stringContaining('not produced') })
    expect(options.onArtifact).not.toHaveBeenCalled()
  })
  it('requires the requested format, not a text placeholder', async () => {
    const { options, deps } = fixture('Generate an Excel report')
    next.mockResolvedValueOnce({ type: 'save_file', filename: 'report.txt', format: 'txt', content: 'Report' }).mockResolvedValue(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'incomplete' })
  })
  it('requires all formats when PDF and Excel are both requested', async () => {
    const { options, deps } = fixture('Provide a PDF report and Excel sheet')
    next.mockResolvedValueOnce({ type: 'save_spreadsheet', filename: 'report.xlsx', columns: ['Name'], rows: [['Data']] }).mockResolvedValue(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'incomplete' })
    expect(options.onArtifact).toHaveBeenCalledTimes(1)
  })
  it('completes a multi-format request after producing every requested format', async () => {
    const { options, deps } = fixture('Provide a PDF report and Excel sheet')
    next.mockResolvedValueOnce({ type: 'save_spreadsheet', filename: 'report.xlsx', columns: ['Name'], rows: [['Data']] })
      .mockResolvedValueOnce({ type: 'save_file', filename: 'report.pdf', format: 'pdf', content: 'Verified report data' }).mockResolvedValueOnce(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'completed' })
    expect(options.onArtifact).toHaveBeenCalledTimes(2)
  })
  it('accepts one explicitly alternative format', async () => {
    const { options, deps } = fixture('Provide the report in PDF or DOCX')
    next.mockResolvedValueOnce({ type: 'save_file', filename: 'report.docx', format: 'docx', content: 'Verified report data' }).mockResolvedValueOnce(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'completed' })
  })
  it.each([
    'Read the attached PDF and create an Excel report',
    'Create an Excel report from the attached PDF',
    'Convert the uploaded PDF to Excel',
    'Provide a summary of the attached PDF in Excel',
    'I need to read the PDF and create an Excel report'
  ])('does not mistake an input document format for an output format: %s', async task => {
    const { options, deps } = fixture(task)
    next.mockResolvedValueOnce({ type: 'save_spreadsheet', filename: 'report.xlsx', columns: ['Name'], rows: [['Observed data']] }).mockResolvedValueOnce(finish)
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'completed' })
  })
  it('gives the model safe actionable document errors without exposing input values', async () => {
    const { options, deps } = fixture('Create a JSON file')
    next.mockResolvedValueOnce({ type: 'save_file', filename: 'data.json', format: 'json', content: '{bad}' })
      .mockResolvedValueOnce({ type: 'save_file', filename: 'data.json', format: 'json', content: '{"valid":true}' }).mockResolvedValueOnce(finish)
    vi.mocked(deps.createArtifact).mockRejectedValueOnce(new Error('JSON content is invalid. Supply a complete JSON value.'))
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'completed' })
    expect(JSON.stringify(vi.mocked(options.onEvent).mock.calls)).toContain('Supply a complete valid JSON value')
    expect(JSON.stringify(vi.mocked(options.onEvent).mock.calls)).not.toContain('{bad}')
  })
  it('allows an honest incomplete response with no generated file', async () => {
    const { options, deps } = fixture('Export the contacts to XLSX')
    next.mockResolvedValue({ type: 'finish', outcome: 'incomplete', summary: 'Contacts are not visible on this page.' })
    expect(await runAgent(options, deps)).toEqual({ outcome: 'incomplete', summary: 'Contacts are not visible on this page.' })
  })
  it('does not emit a file after cancellation while generation is still running', async () => {
    const { options, deps, controller } = fixture('Create a PDF')
    next.mockResolvedValue({ type: 'save_file', filename: 'report.pdf', format: 'pdf', content: 'Report' })
    let resolveArtifact!: (artifact: Awaited<ReturnType<AgentDependencies['createArtifact']>>) => void
    vi.mocked(deps.createArtifact).mockImplementation(() => new Promise(resolve => { resolveArtifact = resolve }))
    const operation = runAgent(options, deps)
    await vi.waitFor(() => expect(deps.createArtifact).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await operation).toMatchObject({ outcome: 'stopped' })
    resolveArtifact({ id: 'late', name: 'late.pdf', mime: 'application/pdf', size: 4, blob: new Blob(['data']) })
    await Promise.resolve()
    expect(options.onArtifact).not.toHaveBeenCalled()
  })
  it('does not count empty or failed generated artifacts', async () => {
    const { options, deps } = fixture('Create a PDF')
    next.mockResolvedValue({ type: 'save_file', filename: 'report.pdf', format: 'pdf', content: 'Report' })
    vi.mocked(deps.createArtifact).mockResolvedValue({ id: 'empty', name: 'empty.pdf', mime: 'application/pdf', size: 0, blob: new Blob([]) })
    expect(await runAgent(options, deps)).toMatchObject({ outcome: 'incomplete' })
    expect(options.onArtifact).not.toHaveBeenCalled()
  })
})
