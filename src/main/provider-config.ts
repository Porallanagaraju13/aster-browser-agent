import { GoogleGenAI } from '@google/genai'
import type {
  ModelProvider,
  ProviderCredentialInput,
  ProviderCredentialStatus
} from '../shared/types'

export const PROVIDER_DEFAULT_MODELS: Record<ModelProvider, string> = {
  google: 'gemini-3.7-flash',
  openrouter: 'google/gemini-3-flash-preview',
  groq: 'qwen/qwen3.6-27b',
  nvidia: ''
}

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  nvidia: 'NVIDIA NIM'
}

export const OPENAI_COMPATIBLE_ENDPOINTS: Record<Exclude<ModelProvider, 'google'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions'
}

export const PROVIDER_CATALOG_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/models'
} as const

export class ProviderRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'ProviderRequestError' }
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
  return value === 'openrouter' || value === 'groq' || value === 'nvidia' ? value : 'google'
}

export function environmentCredential(
  preferredProvider: ModelProvider,
  preferredModel: string
): { provider: ModelProvider; model: string; apiKey: string; supportsImages: boolean } | undefined {
  const candidates: Array<[ModelProvider, string | undefined, string | undefined]> = [
    [preferredProvider, environmentKey(preferredProvider), preferredModel],
    ['google', process.env['GEMINI_API_KEY'], process.env['GEMINI_MODEL']],
    ['openrouter', process.env['OPENROUTER_API_KEY'], process.env['OPENROUTER_MODEL']],
    ['groq', process.env['GROQ_API_KEY'], process.env['GROQ_MODEL']],
    ['nvidia', process.env['NVIDIA_API_KEY'], process.env['NVIDIA_MODEL']]
  ]
  for (const [provider, rawKey, rawModel] of candidates) {
    const apiKey = rawKey?.trim()
    if (!apiKey) continue
    return {
      provider,
      model: rawModel?.trim() || environmentModel(provider)?.trim() || PROVIDER_DEFAULT_MODELS[provider],
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
    configured: Boolean(credential?.model?.trim()),
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
  if (!Object.hasOwn(PROVIDER_LABELS, input.provider)) throw new ProviderRequestError('Choose Google Gemini, OpenRouter, Groq or NVIDIA NIM.')
  const provider = input.provider
  const apiKey = input.apiKey.trim()
  const model = input.model.trim()
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new ProviderRequestError('Enter an API key without line breaks.')
  if (!model || model.length > 160 || /\s/.test(model)) throw new ProviderRequestError('Enter an exact model ID, without spaces (at most 160 characters).')

  try {
    if (provider === 'google') {
      const client = new GoogleGenAI({ apiKey })
      const details = await client.models.get({ model, config: { httpOptions: { timeout: 20_000 } } })
      if (details.supportedActions && !details.supportedActions.includes('generateContent')) {
        throw new ProviderRequestError('Choose a Gemini chat model that supports content generation and tools.')
      }
      return { supportsImages: true }
    }

    if (provider === 'openrouter') {
      await checkedJson('https://openrouter.ai/api/v1/key', apiKey, fetchImpl, provider)
      const result = await checkedJson(
        PROVIDER_CATALOG_ENDPOINTS.openrouter,
        apiKey,
        fetchImpl,
        provider
      ) as { data?: CatalogModel[] }
      const selected = Array.isArray(result.data) ? result.data.find((entry) => entry.id === model) : undefined
      if (!selected) {
        throw new ProviderRequestError('The exact OpenRouter model ID was not found in its catalog. Paste the ID from your provider dashboard.')
      }
      return catalogCapabilities(selected)
    }

    const result = await checkedJson(
      PROVIDER_CATALOG_ENDPOINTS[provider],
      apiKey,
      fetchImpl,
      provider
    ) as { data?: CatalogModel[] }
    const selected = Array.isArray(result.data) ? result.data.find((entry) => entry.id === model && entry.active !== false) : undefined
    if (!selected) {
      throw new ProviderRequestError(`The exact ${PROVIDER_LABELS[provider]} model ID is unavailable in its catalog. Paste a supported chat model ID from your provider dashboard.`)
    }
    return catalogCapabilities(selected)
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error
    const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
    if (typeof status === 'number') throw new ProviderRequestError(providerHttpError(provider, status))
    throw new ProviderRequestError(`${PROVIDER_LABELS[provider]} catalog validation could not finish. Check your connection, API key and model ID. No inference request was made.`)
  }
}

function catalogCapabilities(model: CatalogModel): ModelCapabilities {
  if (Array.isArray(model.supported_parameters) && !model.supported_parameters.includes('tools')) {
    throw new ProviderRequestError('This model does not support tool calling. Choose a tool-capable chat model.')
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
    method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new ProviderRequestError(providerHttpError(provider, response.status))
  }
  // OpenRouter's full catalog can be large; still bound declared and actual bytes.
  const maxBytes = 8 * 1024 * 1024
  const limitMessage = `${PROVIDER_LABELS[provider]} catalog exceeded the safe 8 MiB response limit. Validation stopped; no inference request was made.`
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ProviderRequestError(limitMessage)
  }
  if (!response.body) throw new ProviderRequestError(`${PROVIDER_LABELS[provider]} returned an empty catalog response. No inference request was made.`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ProviderRequestError(limitMessage)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    reader.releaseLock()
  }
}

export function providerHttpError(provider: ModelProvider, status: number, operation: 'validation' | 'request' = 'validation'): string {
  const label = PROVIDER_LABELS[provider]
  if (status === 401) return `${label} rejected the API key.`
  if (status === 402) return `${label} requires available credits. Check your provider account balance.`
  if (status === 403) return `${label} denied access to this account or model. Check the key permissions and model access.`
  if (status === 404) return `${label} could not find the model or endpoint. Check the exact model ID.`
  if (status === 429) return `${label} rate limit or account quota was reached.`
  if (status === 400 || status === 422) return `${label} rejected the model request. Check the exact model ID, tool-calling support and allowed input/output limits.`
  return `${label} ${operation} failed (HTTP ${status}). Try again after checking provider availability. No browser action was executed from this response.`
}

function environmentKey(provider: ModelProvider): string | undefined {
  if (provider === 'openrouter') return process.env['OPENROUTER_API_KEY']
  if (provider === 'groq') return process.env['GROQ_API_KEY']
  if (provider === 'nvidia') return process.env['NVIDIA_API_KEY']
  return process.env['GEMINI_API_KEY']
}

function environmentModel(provider: ModelProvider): string | undefined {
  if (provider === 'openrouter') return process.env['OPENROUTER_MODEL']
  if (provider === 'groq') return process.env['GROQ_MODEL']
  if (provider === 'nvidia') return process.env['NVIDIA_MODEL']
  return process.env['GEMINI_MODEL']
}
