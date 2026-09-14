import type { ProviderSettings } from './types'
import { PROVIDERS } from './provider'

export const emptySettings: ProviderSettings = { provider: 'openrouter', model: '', apiKey: '' }
export async function loadSettings(): Promise<ProviderSettings> {
  const [local, session] = await Promise.all([chrome.storage.local.get('providerSettings'), chrome.storage.session.get('credential')])
  const saved = (local.providerSettings && typeof local.providerSettings === 'object' ? local.providerSettings : {}) as Record<string, unknown>
  const credential = session.credential as Partial<ProviderSettings> | undefined
  // Bind the key and destination atomically; never combine a key with separately loaded preferences.
  if (credential && typeof credential.provider === 'string' && Object.hasOwn(PROVIDERS, credential.provider) && typeof credential.apiKey === 'string' && typeof credential.model === 'string') {
    return { provider: credential.provider!, model: credential.model.slice(0, 200), apiKey: credential.apiKey }
  }
  return {
    provider: typeof saved.provider === 'string' && Object.hasOwn(PROVIDERS, saved.provider) ? saved.provider as ProviderSettings['provider'] : 'openrouter',
    model: typeof saved?.model === 'string' ? saved.model.slice(0, 200) : '',
    apiKey: ''
  }
}
export async function saveSettings(settings: ProviderSettings): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  await chrome.storage.session.set({ credential: { provider: settings.provider, model: settings.model.trim(), apiKey: settings.apiKey.trim() } })
  await chrome.storage.local.set({ providerSettings: { provider: settings.provider, model: settings.model.trim() } })
}
export async function forgetKey(): Promise<void> { await chrome.storage.session.remove(['credential', 'apiKey']) }

export function normalizeOrigins(value: string): string[] {
  const origins = value.split(/[\s,]+/).filter(Boolean).map((item) => {
    const url = new URL(item)
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Enter website origins only, such as https://example.com (without paths or login details).')
    }
    return url.origin
  })
  if (!origins.length || origins.length > 10) throw new Error('Choose between 1 and 10 website origins.')
  return [...new Set(origins)]
}
