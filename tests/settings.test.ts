import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/settings'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store(): Promise<{ root: string; file: string; settings: SettingsStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aster-settings-test-'))
  tempRoots.push(root)
  const file = path.join(root, 'settings.json')
  return { root, file, settings: new SettingsStore(file) }
}

describe('SettingsStore production hardening', () => {
  it('returns visible-browser defaults without a stale visibility toggle', async () => {
    const { settings } = await store()
    const value = await settings.get()

    expect(value.maxSteps).toBe(60)
    expect(value.provider).toBe('google')
    expect(value.model).toBe('gemini-3.7-flash')
    expect(value.allowlist).toEqual(['localhost', '127.0.0.1'])
    expect('showBrowser' in value).toBe(false)
  })

  it('bounds and normalizes untrusted settings values', async () => {
    const { settings } = await store()
    const value = await settings.save({
      provider: 'openrouter',
      model: `  ${'m'.repeat(180)}  `,
      maxSteps: 999,
      allowlist: [' example.com ', 'example.com', null as unknown as string]
    })

    expect(value.model).toHaveLength(160)
    expect(value.provider).toBe('openrouter')
    expect(value.maxSteps).toBe(200)
    expect(value.allowlist).toEqual(['example.com'])
  })

  it('recovers from a corrupted settings file', async () => {
    const { file, settings } = await store()
    await writeFile(file, '{broken-json', 'utf8')

    await expect(settings.get()).resolves.toMatchObject({ maxSteps: 60 })
  })

  it('preserves the exact model selected and validated by the user', async () => {
    const { settings } = await store()
    const value = await settings.save({
      provider: 'google',
      model: 'gemini-2.5-flash',
      maxSteps: 60,
      allowlist: []
    })

    expect(value.model).toBe('gemini-2.5-flash')
    await expect(settings.get()).resolves.toMatchObject({ model: 'gemini-2.5-flash' })
    const longModel = `provider/${'m'.repeat(140)}`
    await settings.save({ ...value, provider: 'openrouter', model: longModel })
    await expect(settings.get()).resolves.toMatchObject({ model: longModel })
  })

  it('preserves NVIDIA and does not invent a runnable model when no model was entered', async () => {
    const { settings } = await store()
    const value = await settings.save({ provider: 'nvidia', model: '', maxSteps: 60, allowlist: [] })
    expect(value).toMatchObject({ provider: 'nvidia', model: '' })
    await expect(settings.get()).resolves.toMatchObject({ provider: 'nvidia', model: '' })
    await settings.save({ ...value, model: 'vendor/exact-model:version' })
    await expect(settings.get()).resolves.toMatchObject({ provider: 'nvidia', model: 'vendor/exact-model:version' })
  })
})
