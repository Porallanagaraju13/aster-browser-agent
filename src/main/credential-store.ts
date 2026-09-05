import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ModelProvider } from '../shared/types'
import { normalizeProvider, PROVIDER_DEFAULT_MODELS } from './provider-config'

export interface EncryptionAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface StoredProviderCredential {
  provider: ModelProvider
  model: string
  apiKey: string
  supportsImages?: boolean
}

interface CredentialFile {
  version: 1
  provider: ModelProvider
  model: string
  encryptedKey: string
  supportsImages?: boolean
}

export class CredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly encryption: EncryptionAdapter
  ) {}

  isEncryptionAvailable(): boolean {
    return this.encryption.isEncryptionAvailable()
  }

  async get(): Promise<StoredProviderCredential | undefined> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CredentialFile>
      if (parsed.version !== 1 || !parsed.encryptedKey) throw new Error('Unsupported credential data.')
      const provider = normalizeProvider(parsed.provider)
      const model = String(parsed.model ?? '').trim().slice(0, 160) || PROVIDER_DEFAULT_MODELS[provider]
      const apiKey = this.encryption.decryptString(Buffer.from(parsed.encryptedKey, 'base64')).trim()
      if (!apiKey) throw new Error('The stored API key is empty.')
      return { provider, model, apiKey, supportsImages: parsed.supportsImages ?? provider === 'google' }
    } catch {
      throw new Error('Aster could not decrypt the saved API key. Remove it and connect again.')
    }
  }

  async save(credential: StoredProviderCredential): Promise<void> {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('Secure operating-system encryption is unavailable. The API key was not saved.')
    }
    const provider = normalizeProvider(credential.provider)
    const model = credential.model.trim().slice(0, 160)
    const apiKey = credential.apiKey.trim()
    if (!model || !apiKey) throw new Error('Provider, model, and API key are required.')

    const payload: CredentialFile = {
      version: 1,
      provider,
      model,
      encryptedKey: this.encryption.encryptString(apiKey).toString('base64'),
      supportsImages: credential.supportsImages ?? provider === 'google'
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8')
    await rename(temporaryPath, this.filePath)
  }

  async remove(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
