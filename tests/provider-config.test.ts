import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialStatus, environmentCredential, normalizeProvider, PROVIDER_DEFAULT_MODELS, validateProviderCredential } from '../src/main/provider-config'

afterEach(() => vi.unstubAllEnvs())

describe('provider credential validation', () => {
  it('validates an OpenRouter key and exact model ID using official endpoints', async () => {
    const request = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: { label: 'test' } }))
      return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-4.5' }] }))
    })
    await expect(validateProviderCredential({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      apiKey: 'openrouter-secret'
    }, request as typeof fetch)).resolves.toEqual({ supportsImages: false })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer openrouter-secret'
    })
  })

  it('validates Groq model access and returns a helpful unavailable-model error', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'qwen/qwen3.6-27b', active: true }]
    })))
    await expect(validateProviderCredential({
      provider: 'groq', model: 'qwen/qwen3.6-27b', apiKey: 'groq-secret'
    }, request as typeof fetch)).resolves.toEqual({ supportsImages: false })
    await expect(validateProviderCredential({
      provider: 'groq', model: 'missing-model', apiKey: 'groq-secret'
    }, request as typeof fetch)).rejects.toThrow('unavailable')
  })

  it('rejects known tool-incompatible models while allowing tool-capable text models', async () => {
    const request = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith('/key') ? { data: {} } : { data: [
        { id: 'no-tools', supported_parameters: [], architecture: { input_modalities: ['text'] } },
        { id: 'text-tools', supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } },
        { id: 'vision-tools', supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } }
      ] }
    )))
    const input = { provider: 'openrouter' as const, apiKey: 'secret' }
    await expect(validateProviderCredential({ ...input, model: 'no-tools' }, request)).rejects.toThrow('does not support tool calling')
    await expect(validateProviderCredential({ ...input, model: 'text-tools' }, request)).resolves.toEqual({ supportsImages: false })
    await expect(validateProviderCredential({ ...input, model: 'vision-tools' }, request)).resolves.toEqual({ supportsImages: true })
  })

  it('checks the exact NVIDIA hosted catalog without making a paid inference request', async () => {
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'vendor/exact-model', object: 'model' }] })))
    await expect(validateProviderCredential({ provider: 'nvidia', model: 'vendor/exact-model', apiKey: 'nvapi-fixture-key' }, request)).resolves.toEqual({ supportsImages: false })
    expect(request).toHaveBeenCalledExactlyOnceWith('https://integrate.api.nvidia.com/v1/models', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Bearer nvapi-fixture-key', Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store'
    }))
    expect(request.mock.calls[0][1]).not.toHaveProperty('body')
    expect(normalizeProvider('nvidia')).toBe('nvidia')
    expect(PROVIDER_DEFAULT_MODELS.nvidia).toBe('')
  })

  it.each(['', '   ', 'model with spaces'])('requires an explicit valid NVIDIA model before any network request: %j', async (model) => {
    const request = vi.fn()
    await expect(validateProviderCredential({ provider: 'nvidia', model, apiKey: 'nvapi-fixture-key' }, request)).rejects.toThrow('exact model ID')
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps NVIDIA environment credentials unconfigured until an exact model is supplied', () => {
    for (const provider of ['GEMINI', 'OPENROUTER', 'GROQ', 'NVIDIA']) {
      vi.stubEnv(`${provider}_API_KEY`, '')
      vi.stubEnv(`${provider}_MODEL`, '')
    }
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fixture-key')
    const missingModel = environmentCredential('nvidia', '')
    expect(missingModel).toMatchObject({ provider: 'nvidia', model: '' })
    expect(credentialStatus(missingModel, 'environment', true).configured).toBe(false)
    vi.stubEnv('NVIDIA_MODEL', 'vendor/explicit-model')
    const configured = environmentCredential('nvidia', '')
    expect(configured).toMatchObject({ provider: 'nvidia', model: 'vendor/explicit-model' })
    expect(credentialStatus(configured, 'environment', true).configured).toBe(true)
    expect(environmentCredential('nvidia', 'vendor/preferred-model')?.model).toBe('vendor/preferred-model')
  })

  it.each([401, 403, 404, 429])('does not retry or expose raw NVIDIA catalog errors (HTTP %s)', async (status) => {
    const key = 'nvapi-fixture-key'
    const request = vi.fn(async () => new Response(JSON.stringify({ error: { message: `Private response ${key}` } }), { status }))
    const error = await validateProviderCredential({ provider: 'nvidia', model: 'vendor/model', apiKey: key }, request).catch((caught: Error) => caught)
    expect(String(error)).toContain('NVIDIA NIM')
    expect(String(error)).not.toMatch(/Private response|nvapi-fixture-key/)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('returns safe catalog connection errors without exposing a raw fetch exception', async () => {
    const request = vi.fn(async () => { throw new Error('Authorization: Bearer private-key; model=private-model') })
    const error = await validateProviderCredential({ provider: 'nvidia', model: 'vendor/model', apiKey: 'key' }, request).catch((caught: Error) => caught)
    expect(String(error)).toContain('No inference request was made')
    expect(String(error)).not.toMatch(/private-key|private-model/)
  })

  it('rejects an oversized catalog content-length and cancels the body before reading it', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-length': String(8 * 1024 * 1024 + 1) }
    })
    const request = vi.fn(async () => response)
    await expect(validateProviderCredential({ provider: 'nvidia', model: 'vendor/model', apiKey: 'key' }, request)).rejects.toThrow('safe 8 MiB response limit')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('caps actual catalog stream bytes even when content-length is missing or misleading', async () => {
    for (const headers of [new Headers(), new Headers({ 'content-length': '10' })]) {
      const cancel = vi.fn()
      let index = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(index++ === 0 ? new Uint8Array(8 * 1024 * 1024) : new Uint8Array(1))
        },
        cancel
      })
      const request = vi.fn(async () => new Response(body, { headers }))
      await expect(validateProviderCredential({ provider: 'groq', model: 'vendor/model', apiKey: 'key' }, request)).rejects.toThrow('safe 8 MiB response limit')
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledTimes(1)
    }
  })

  it('allows a valid catalog exactly at the byte limit', async () => {
    const catalog = JSON.stringify({ data: [{ id: 'vendor/model' }] })
    const response = new Response(catalog.padEnd(8 * 1024 * 1024, ' '))
    await expect(validateProviderCredential({ provider: 'nvidia', model: 'vendor/model', apiKey: 'key' }, async () => response)).resolves.toEqual({ supportsImages: false })
  })

  it('does not expose raw catalog parser errors or provider content', async () => {
    const response = new Response('{"nvapi-sensitive-payload":broken}')
    const error = await validateProviderCredential({ provider: 'nvidia', model: 'vendor/model', apiKey: 'key' }, async () => response).catch((caught: Error) => caught)
    expect(String(error)).toContain('catalog validation could not finish')
    expect(String(error)).not.toContain('sensitive-payload')
  })
})
