import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatiblePlanner } from '../src/main/planner'
import type { PageObservation } from '../src/shared/types'

const observation: PageObservation = {
  url: 'https://example.com/',
  title: 'Example Domain',
  text: 'Example Domain',
  elements: [],
  screenshotDataUrl: 'data:image/png;base64,aGVsbG8=',
  screenshotPath: 'step.png',
  tabs: [{ id: 't1', title: 'Example Domain', url: 'https://example.com/', active: true }],
  activeTabId: 't1'
}

function toolResponse(name = 'inspect_page', args = '{}', finishReason = 'tool_calls'): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: args } }]
    } }]
  }))
}

describe('OpenAICompatiblePlanner', () => {
  it('sends OpenRouter multimodal observations and continues with tool results', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const index = bodies.length
      return new Response(JSON.stringify({
        id: `response-${index}`,
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: `call-${index}`,
              type: 'function',
              function: index === 1
                ? { name: 'navigate', arguments: '{"url":"https://example.com"}' }
                : { name: 'finish', arguments: '{"summary":"Done"}' }
            }]
          }
        }]
      }))
    })
    const planner = new OpenAICompatiblePlanner({
      provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', apiKey: 'secret', supportsImages: true
    }, request as typeof fetch)

    const first = await planner.begin('Open Example Domain.', observation)
    expect(first.actions[0]).toMatchObject({ name: 'navigate' })
    const firstBody = bodies[0]
    expect(firstBody.model).toBe('anthropic/claude-sonnet-4.5')
    expect(JSON.stringify(firstBody)).toContain('image_url')
    expect(JSON.stringify(firstBody)).toContain('save_file')

    const second = await planner.continue(first.responseId, [{
      action: first.actions[0],
      result: { ok: true, message: 'Navigated.' }
    }], observation)
    expect(second.actions[0]).toMatchObject({ name: 'finish' })
    expect(JSON.stringify(bodies[1])).toContain('tool_call_id')
    expect(JSON.stringify(bodies[1])).toContain('LATEST VERIFIED BROWSER OBSERVATION')
  })

  it('uses the Groq chat-completions endpoint', async () => {
    let requestedUrl = ''
    const request = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done' } }] }))
    })
    const planner = new OpenAICompatiblePlanner({
      provider: 'groq', model: 'qwen/qwen3.6-27b', apiKey: 'secret'
    }, request as typeof fetch)
    await planner.begin('Inspect the page.', observation)
    expect(requestedUrl).toBe('https://api.groq.com/openai/v1/chat/completions')
  })

  it('uses the semantic page map without sending images to text-only or unknown models', async () => {
    let body = ''
    const planner = new OpenAICompatiblePlanner({ provider: 'groq', model: 'text-tool-model', apiKey: 'secret' }, async (_url, init) => {
      body = String(init?.body)
      return toolResponse()
    })
    await planner.begin('Read the page.', observation)
    expect(body).toContain('DOM-only')
    expect(body).toContain('Example Domain')
    expect(body).not.toContain('image_url')
    expect(body).not.toContain('data:image')
  })

  it('retries a cut-off document response with more output capacity before executing it', async () => {
    const limits: number[] = []
    const bodies: string[] = []
    const content = 'Verified report paragraph. '.repeat(600)
    const planner = new OpenAICompatiblePlanner({ provider: 'openrouter', model: 'model', apiKey: 'secret' }, async (_url, init) => {
      bodies.push(String(init?.body))
      limits.push(JSON.parse(String(init?.body)).max_completion_tokens)
      return limits.length === 1
        ? toolResponse('save_file', '{"filename":"report.docx","content":"cut', 'length')
        : toolResponse('save_file', JSON.stringify({ filename: 'report.docx', format: 'docx', content }))
    })
    const turn = await planner.begin('Create a complete document.', observation)
    expect(limits).toEqual([8192, 16384])
    expect(turn.actions[0].arguments.content).toBe(content)
    expect(bodies[1]).not.toContain('"role":"assistant"')
  })

  it('fails clearly after bounded truncation retries without exposing a partial action', async () => {
    const request = vi.fn(async () => toolResponse('save_file', '{"content":"cut', 'length'))
    const planner = new OpenAICompatiblePlanner({ provider: 'groq', model: 'model', apiKey: 'secret' }, request)
    await expect(planner.begin('Export a report.', observation)).rejects.toThrow('No partial file or browser action was executed')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['invalid JSON', 'click', '{broken'],
    ['missing field', 'click', '{}'],
    ['wrong type', 'click', '{"ref":5}'],
    ['unknown tool', 'execute_script', '{}']
  ])('rejects %s instead of dispatching an invalid tool action', async (_label, name, args) => {
    const request = vi.fn(async () => toolResponse(name, args))
    const planner = new OpenAICompatiblePlanner({ provider: 'groq', model: 'model', apiKey: 'secret' }, request)
    await expect(planner.begin('Use a browser tool.', observation)).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('retries transient provider throttling and preserves the original request', async () => {
    const bodies: string[] = []
    const planner = new OpenAICompatiblePlanner({ provider: 'groq', model: 'model', apiKey: 'secret' }, async (_url, init) => {
      bodies.push(String(init?.body))
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: { message: 'Rate limit' } }), { status: 429, headers: { 'retry-after': '0' } })
        : toolResponse()
    })
    await expect(planner.begin('Inspect the page.', observation)).resolves.toMatchObject({ actions: [{ name: 'inspect_page' }] })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
  })

  it('passes Stop cancellation to the in-flight provider request and does not retry', async () => {
    const abort = new AbortController()
    let requestedSignal: AbortSignal | undefined | null
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestedSignal = init?.signal
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    const planner = new OpenAICompatiblePlanner({ provider: 'groq', model: 'model', apiKey: 'secret', signal: abort.signal }, request)
    const pending = planner.begin('Inspect the page.', observation)
    abort.abort(new Error('Stopped by user'))
    await expect(pending).rejects.toThrow('Stopped by user')
    expect(requestedSignal?.aborted).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('falls back to the DOM if a provider rejects an advertised vision capability', async () => {
    const bodies: string[] = []
    const planner = new OpenAICompatiblePlanner({ provider: 'openrouter', model: 'model', apiKey: 'secret', supportsImages: true }, async (_url, init) => {
      bodies.push(String(init?.body))
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: { message: 'Image input is unsupported' } }), { status: 400 })
        : toolResponse()
    })
    await planner.begin('Read the page.', observation)
    expect(bodies[0]).toContain('image_url')
    expect(bodies[1]).not.toContain('image_url')
    expect(bodies[1]).toContain('DOM-only')
  })

  it('bounds long-run history while preserving the task, artifact paths, and valid tool pairs', async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
    const planner = new OpenAICompatiblePlanner({ provider: 'groq', model: 'model', apiKey: 'secret' }, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return toolResponse()
    })
    const largeObservation = { ...observation, text: 'Verified source detail. '.repeat(650) }
    let turn = await planner.begin('Original approved task', largeObservation)
    for (let step = 0; step < 30; step += 1) {
      turn = await planner.continue(turn.responseId, [{
        action: turn.actions[0],
        result: { ok: true, message: 'Inspected.', ...(step === 0 ? { data: { path: 'C:\\artifacts\\report.docx' } } : {}) }
      }], largeObservation)
    }
    const last = bodies.at(-1)!
    expect(JSON.stringify(last.messages).length).toBeLessThan(120_000)
    expect(JSON.stringify(last.messages)).toContain('Original approved task')
    expect(JSON.stringify(last.messages)).toContain('report.docx')
    expect(JSON.stringify(last.messages)).toContain('Older page observations were removed')
    expect(last.messages[2].role).toBe('user')
    for (let index = 0; index < last.messages.length; index += 1) {
      if (last.messages[index].role === 'tool') expect(last.messages[index - 1].role).toBe('assistant')
    }
  })
})
