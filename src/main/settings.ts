import { readFile, writeFile } from 'node:fs/promises'
import type { AppSettings } from '../shared/types'
import { normalizeProvider, PROVIDER_DEFAULT_MODELS } from './provider-config'

const DEFAULT_SETTINGS: AppSettings = {
  provider: 'google',
  model: process.env['GEMINI_MODEL'] || 'gemini-3.7-flash',
  maxSteps: 60,
  allowlist: ['localhost', '127.0.0.1']
}

export class SettingsStore {
  constructor(private readonly filePath: string) {}

  async get(): Promise<AppSettings> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AppSettings>
      return this.sanitize({ ...DEFAULT_SETTINGS, ...parsed })
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const sanitized = this.sanitize(settings)
    await writeFile(this.filePath, JSON.stringify(sanitized, null, 2), 'utf8')
    return sanitized
  }

  private sanitize(settings: AppSettings): AppSettings {
    const provider = normalizeProvider(settings.provider)
    const model = typeof settings.model === 'string' ? settings.model.trim().slice(0, 160) : ''
    const allowlist = Array.isArray(settings.allowlist) ? settings.allowlist : []
    return {
      provider,
      model: model || PROVIDER_DEFAULT_MODELS[provider],
      maxSteps: Math.min(Math.max(Math.round(Number(settings.maxSteps) || 60), 1), 200),
      allowlist: [...new Set(
        allowlist
          .filter((host): host is string => typeof host === 'string')
          .map((host) => host.trim().slice(0, 253))
          .filter(Boolean)
      )].slice(0, 100)
    }
  }
}
