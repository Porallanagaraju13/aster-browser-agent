import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => vi.restoreAllMocks())

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
      return toolResponse()
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
      limits.push(JSON.parse(String(init?.body)).max_tokens)
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

  it.each([
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'max_tokens', 8192],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions', 'max_completion_tokens', 8192],
    ['nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions', 'max_tokens', 2048]
  ] as const)('uses the documented %s request parameters and fixed endpoint', async (provider, endpoint, limitKey, limit) => {
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => toolResponse())
    const planner = new OpenAICompatiblePlanner({ provider, model: 'vendor/exact-model:version', apiKey: 'fixture-provider-key' }, request)
    await planner.begin('Inspect the page.', observation)
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]
    expect(url).toBe(endpoint)
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', method: 'POST' })
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-provider-key' })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ model: 'vendor/exact-model:version', [limitKey]: limit, tool_choice: 'auto', stream: false })
    expect(body).not.toHaveProperty(limitKey === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens')
    expect(body.tools.length).toBeGreaterThan(5)
    if (provider === 'nvidia') {
      expect(body).not.toHaveProperty('parallel_tool_calls')
      expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user'])
      expect(typeof body.messages[1].content).toBe('string')
      expect(body.messages[1].content).toContain('USER TASK:')
      expect(body.messages[1].content).toContain('CURRENT BROWSER OBSERVATION:')
    }
  })

  it('caps NVIDIA output recovery at 4096 tokens without retrying an unchanged limit', async () => {
    const limits: number[] = []
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'vendor/chat-model', apiKey: 'fixture-key' }, async (_url, init) => {
      limits.push(JSON.parse(String(init?.body)).max_tokens)
      return toolResponse('save_file', '{"content":"cut', 'length')
    })
    await expect(planner.begin('Create a report.', observation)).rejects.toThrow('No partial file or browser action')
    expect(limits).toEqual([2048, 4096])
  })

  it.each([400, 401, 402, 403, 404, 422])('fails safely on HTTP %s without repeating an unchanged rejected request', async (status) => {
    const key = 'nvapi-synthetic-provider-key'
    const request = vi.fn(async () => new Response(JSON.stringify({ error: { message: { secret: key, userTask: 'PRIVATE TASK' } } }), { status }))
    const progress = vi.fn()
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'private-model', apiKey: key, onProgress: progress }, request)
    const error = await planner.begin('PRIVATE TASK', observation).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('NVIDIA NIM')
    expect(String(error)).not.toMatch(/synthetic-provider-key|PRIVATE TASK|replaceAll|TypeError/)
    expect(JSON.stringify(progress.mock.calls)).not.toMatch(/synthetic-provider-key|PRIVATE TASK|private-model/)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('handles a provider error envelope with HTTP 200 without leaking its message', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: { code: 429, message: 'private payload nvapi-secret-123456789' } })))
    const planner = new OpenAICompatiblePlanner({ provider: 'openrouter', model: 'vendor/model', apiKey: 'key' }, request)
    const error = await planner.begin('Inspect.', observation).catch((caught: Error) => caught)
    expect(String(error)).toContain('rate limit or account quota')
    expect(String(error)).not.toContain('private payload')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { role: 'assistant', content: 'I completed the task.' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'assistant' }
  ])('rejects no-action assistant responses without claiming completion', async (message) => {
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message }] })))
    const planner = new OpenAICompatiblePlanner({ provider: 'groq', model: 'model', apiKey: 'key' }, request)
    await expect(planner.begin('Inspect.', observation)).rejects.toThrow('instead of a browser action')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized streamed responses before parsing them or dispatching actions', async () => {
    const request = vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'model', apiKey: 'key' }, request)
    await expect(planner.begin('Inspect.', observation)).rejects.toThrow('safe size limit')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects asynchronous queued responses rather than waiting on a blank browser', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 202 }))
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'model', apiKey: 'key' }, request)
    await expect(planner.begin('Inspect.', observation)).rejects.toThrow('queued the request')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stops a timed-out request and reports a safe actionable error without automatic retry', async () => {
    const timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const progress = vi.fn()
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'model', apiKey: 'key', onProgress: progress }, request)
    const pending = planner.begin('Inspect.', observation)
    timeout.abort(new DOMException('Timeout', 'TimeoutError'))
    await expect(pending).rejects.toThrow('within 90 seconds')
    expect(request).toHaveBeenCalledTimes(1)
    expect(progress.mock.calls.flat().join(' ')).toContain('timed out')
  })

  it('never calls the provider when already stopped', async () => {
    const abort = new AbortController()
    abort.abort(new Error('Stopped'))
    const request = vi.fn(async () => toolResponse())
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'model', apiKey: 'key', signal: abort.signal }, request)
    await expect(planner.begin('Inspect.', observation)).rejects.toThrow('Stopped')
    expect(request).not.toHaveBeenCalled()
  })

  it('blocks model actions containing the configured API key before any dispatch or retry', async () => {
    const key = 'nvapi-synthetic-test-key-123'
    const request = vi.fn(async () => toolResponse('type_text', JSON.stringify({ ref: 'e1', text: key })))
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'model', apiKey: key }, request)
    await expect(planner.begin('Inspect.', observation)).rejects.toThrow('blocked before any browser or file action')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('redacts the configured key from model context and visible response text', async () => {
    const key = 'nvapi-synthetic-test-key-123'
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: {
      content: `Inspecting with ${key}`,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'inspect_page', arguments: '{}' } }]
    } }] })))
    const planner = new OpenAICompatiblePlanner({ provider: 'nvidia', model: 'model', apiKey: key, onProgress: () => { throw new Error('UI failed') } }, request)
    const result = await planner.begin(`Inspect without exposing ${key}.`, { ...observation, text: `Untrusted text ${key}` })
    expect(String(request.mock.calls[0][1]?.body)).not.toContain(key)
    expect(result.message).not.toContain(key)
    expect(result.actions[0].name).toBe('inspect_page')
  })
})
