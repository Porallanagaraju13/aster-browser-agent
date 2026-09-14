import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore, type EncryptionAdapter } from '../src/main/credential-store'

const created: string[] = []
const encryption: EncryptionAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^protected:/, '')
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

describe('CredentialStore', () => {
  it('stores provider credentials encrypted and restores the selected model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aster-credential-test-'))
    created.push(root)
    const file = path.join(root, 'credentials.json')
    const store = new CredentialStore(file, encryption)
    await store.save({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', apiKey: 'secret-key', supportsImages: true })

    expect(await readFile(file, 'utf8')).not.toContain('secret-key')
    await expect(store.get()).resolves.toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      apiKey: 'secret-key',
      supportsImages: true
    })

    await store.save({ provider: 'groq', model: 'qwen/qwen3.6-27b', apiKey: 'replacement-key' })
    await expect(store.get()).resolves.toEqual({
      provider: 'groq',
      model: 'qwen/qwen3.6-27b',
      apiKey: 'replacement-key',
      supportsImages: false
    })

    await store.remove()
    await expect(store.get()).resolves.toBeUndefined()
  })

  it('refuses plaintext storage when OS encryption is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aster-credential-test-'))
    created.push(root)
    const store = new CredentialStore(path.join(root, 'credentials.json'), {
      ...encryption,
      isEncryptionAvailable: () => false
    })
    await expect(store.save({ provider: 'groq', model: 'model', apiKey: 'key' }))
      .rejects.toThrow('encryption is unavailable')
  })

  it('round-trips NVIDIA credentials through the existing encrypted store without a provider fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aster-credential-test-'))
    created.push(root)
    const file = path.join(root, 'credentials.json')
    const store = new CredentialStore(file, encryption)
    const credential = { provider: 'nvidia' as const, model: 'vendor/exact-model:version', apiKey: 'nvapi-synthetic-test-key', supportsImages: false }
    await store.save(credential)
    expect(await readFile(file, 'utf8')).not.toContain(credential.apiKey)
    await expect(new CredentialStore(file, encryption).get()).resolves.toEqual(credential)
  })
})
