import { GoogleGenAI } from '@google/genai'
import type {
  ModelProvider,
  ProviderCredentialInput,
  ProviderCredentialStatus
} from '../shared/types'

export const PROVIDER_DEFAULT_MODELS: Record<ModelProvider, string> = {
  google: 'gemini-3.7-flash',
  openrouter: 'google/gemini-3-flash-preview',
  groq: 'qwen/qwen3.6-27b'
}

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq'
}

export const OPENAI_COMPATIBLE_ENDPOINTS: Record<'openrouter' | 'groq', string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions'
}

type FetchLike = typeof fetch

export interface ModelCapabilities {
  supportsImages: boolean
}

interface CatalogModel {
  id?: string
  active?: boolean
  supported_parameters?: string[]
  architecture?: { input_modalities?: string[] }
  input_modalities?: string[]
}

export function normalizeProvider(value: unknown): ModelProvider {
  return value === 'openrouter' || value === 'groq' ? value : 'google'
}

export function environmentCredential(
  preferredProvider: ModelProvider,
  preferredModel: string
): { provider: ModelProvider; model: string; apiKey: string; supportsImages: boolean } | undefined {
  const candidates: Array<[ModelProvider, string | undefined, string | undefined]> = [
    [preferredProvider, environmentKey(preferredProvider), preferredModel],
    ['google', process.env['GEMINI_API_KEY'], process.env['GEMINI_MODEL']],
    ['openrouter', process.env['OPENROUTER_API_KEY'], process.env['OPENROUTER_MODEL']],
    ['groq', process.env['GROQ_API_KEY'], process.env['GROQ_MODEL']]
  ]
  for (const [provider, rawKey, rawModel] of candidates) {
    const apiKey = rawKey?.trim()
    if (!apiKey) continue
    return {
      provider,
      model: rawModel?.trim() || PROVIDER_DEFAULT_MODELS[provider],
      apiKey,
      supportsImages: provider === 'google'
    }
  }
  return undefined
}

export function credentialStatus(
  credential: { provider: ModelProvider; model: string; supportsImages?: boolean } | undefined,
  source: ProviderCredentialStatus['source'],
  encryptionAvailable: boolean
): ProviderCredentialStatus {
  return {
    configured: Boolean(credential),
    provider: credential?.provider ?? 'google',
    model: credential?.model ?? PROVIDER_DEFAULT_MODELS.google,
    source: credential ? source : 'none',
    encryptionAvailable,
    supportsImages: credential?.supportsImages ?? credential?.provider === 'google'
  }
}

export async function validateProviderCredential(
  input: Required<ProviderCredentialInput>,
  fetchImpl: FetchLike = fetch
): Promise<ModelCapabilities> {
  const provider = normalizeProvider(input.provider)
  const apiKey = input.apiKey.trim()
  const model = input.model.trim()
  if (!apiKey) throw new Error('Enter an API key.')
  if (!model) throw new Error('Enter a model ID.')

  try {
    if (provider === 'google') {
      const client = new GoogleGenAI({ apiKey })
      const details = await client.models.get({ model, config: { httpOptions: { timeout: 20_000 } } })
      if (details.supportedActions && !details.supportedActions.includes('generateContent')) {
        throw new Error('Choose a Gemini chat model that supports content generation and tools.')
      }
      return { supportsImages: true }
    }

    if (provider === 'openrouter') {
      await checkedJson('https://openrouter.ai/api/v1/key', apiKey, fetchImpl, provider)
      const result = await checkedJson(
        'https://openrouter.ai/api/v1/models',
        apiKey,
        fetchImpl,
        provider
      ) as { data?: CatalogModel[] }
      const selected = result.data?.find((entry) => entry.id === model)
      if (!selected) {
        throw new Error(`OpenRouter model “${model}” was not found for this key.`)
      }
      return catalogCapabilities(selected)
    }

    const result = await checkedJson(
      'https://api.groq.com/openai/v1/models',
      apiKey,
      fetchImpl,
      provider
    ) as { data?: CatalogModel[] }
    const selected = result.data?.find((entry) => entry.id === model && entry.active !== false)
    if (!selected) {
      throw new Error(`Groq model “${model}” is unavailable for this key.`)
    }
    return catalogCapabilities(selected)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replaceAll(apiKey, '[API key hidden]'))
  }
}

function catalogCapabilities(model: CatalogModel): ModelCapabilities {
  if (Array.isArray(model.supported_parameters) && !model.supported_parameters.includes('tools')) {
    throw new Error('This model does not support tool calling. Choose a tool-capable chat model.')
  }
  const inputs = model.architecture?.input_modalities ?? model.input_modalities
  // Unknown image capabilities use the semantic page map until explicitly verified.
  return { supportsImages: Array.isArray(inputs) && inputs.includes('image') }
}

async function checkedJson(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike,
  provider: ModelProvider
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(providerError(provider, response.status, detail))
  }
  return response.json()
}

function providerError(provider: ModelProvider, status: number, detail: string): string {
  const label = PROVIDER_LABELS[provider]
  if (status === 401) return `${label} rejected the API key.`
  if (status === 403) return `${label} accepted the key but denied access to this account or model.`
  if (status === 429) return `${label} rate limit or account quota was reached.`
  const safeDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 300)
  return `${label} validation failed (${status})${safeDetail ? `: ${safeDetail}` : '.'}`
}

function environmentKey(provider: ModelProvider): string | undefined {
  if (provider === 'openrouter') return process.env['OPENROUTER_API_KEY']
  if (provider === 'groq') return process.env['GROQ_API_KEY']
  return process.env['GEMINI_API_KEY']
}
