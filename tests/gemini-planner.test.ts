import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiPlanner } from '../src/main/planner'
import type { PageObservation } from '../src/shared/types'

const sdk = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    interactions = { create: sdk.create }
  }
}))

const observation: PageObservation = {
  url: 'https://example.com', title: 'Example', text: 'Example', elements: [],
  screenshotDataUrl: 'data:image/png;base64,aGVsbG8=', screenshotPath: 'unused', tabs: [], activeTabId: 't1'
}

beforeEach(() => sdk.create.mockReset())

describe('Gemini planner request boundaries', () => {
  it('preserves the chosen model and passes cancellation without forcing an unsupported thinking setting', async () => {
    sdk.create.mockResolvedValue({ id: 'r1', steps: [{ type: 'function_call', id: 'c1', name: 'inspect_page', arguments: {} }] })
    const abort = new AbortController()
    const planner = new GeminiPlanner({ model: 'gemini-2.5-flash', apiKey: 'fake', signal: abort.signal })
    await planner.begin('Read the page.', observation)
    const [request, options] = sdk.create.mock.calls[0]
    expect(request.model).toBe('gemini-2.5-flash')
    expect(request.generation_config).not.toHaveProperty('thinking_level')
    expect(options.signal.aborted).toBe(false)
    abort.abort()
    expect(options.signal.aborted).toBe(true)
  })

  it('does not return a late action after Stop', async () => {
    let resolve!: (value: unknown) => void
    sdk.create.mockReturnValue(new Promise((done) => { resolve = done }))
    const abort = new AbortController()
    const planner = new GeminiPlanner({ model: 'model', apiKey: 'fake', signal: abort.signal })
    const pending = planner.begin('Read the page.', observation)
    abort.abort(new Error('Stopped'))
    resolve({ id: 'r1', steps: [{ type: 'function_call', id: 'c1', name: 'click', arguments: { ref: 'e1' } }] })
    await expect(pending).rejects.toThrow('Stopped')
  })

  it('rejects an incomplete interaction and invalid arguments before executing tools', async () => {
    sdk.create.mockResolvedValueOnce({ id: 'r1', status: 'incomplete' })
    const planner = new GeminiPlanner({ model: 'model', apiKey: 'fake' })
    await expect(planner.begin('Read the page.', observation)).rejects.toThrow('incomplete')
    sdk.create.mockResolvedValueOnce({ id: 'r2', steps: [{ type: 'function_call', id: 'c1', name: 'click', arguments: {} }] })
    await expect(planner.begin('Read the page.', observation)).rejects.toThrow('omitted ref')
  })
})
