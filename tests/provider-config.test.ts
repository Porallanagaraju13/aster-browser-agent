import { describe, expect, it, vi } from 'vitest'
import { validateProviderCredential } from '../src/main/provider-config'

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
})
