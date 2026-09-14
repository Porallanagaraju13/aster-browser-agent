import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptySettings, forgetKey, loadSettings, normalizeOrigins, saveSettings } from '../src/settings'

function mockStorage(localValues: Record<string, unknown> = {}, sessionValues: Record<string, unknown> = {}) {
  const order: string[] = []
  const area = (name: string, initial: Record<string, unknown>) => {
    const values = structuredClone(initial)
    return {
      values,
      get: vi.fn(async (key: string, callback?: (result: Record<string, unknown>) => void) => {
        order.push(`${name}.get`)
        const result = Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}
        callback?.(result)
        return result
      }),
      set: vi.fn(async (items: Record<string, unknown>, callback?: () => void) => {
        order.push(`${name}.set`)
        Object.assign(values, structuredClone(items))
        callback?.()
      }),
      remove: vi.fn(async (key: string | string[], callback?: () => void) => {
        order.push(`${name}.remove`)
        for (const item of typeof key === 'string' ? [key] : key) delete values[item]
        callback?.()
      }),
      setAccessLevel: vi.fn(async (_options: { accessLevel: string }, callback?: () => void) => {
        order.push(`${name}.setAccessLevel`)
        callback?.()
      }),
    }
  }
  const local = area('local', localValues)
  const session = area('session', sessionValues)
  const sync = { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
  vi.stubGlobal('chrome', { storage: { local, session, sync } })
  return { local, session, sync, order }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('session-only provider settings', () => {
  it('loads safe defaults when nothing has been saved', async () => {
    const storage = mockStorage()
    expect(await loadSettings()).toEqual(emptySettings)
    expect(storage.local.get).toHaveBeenCalledWith('providerSettings')
    expect(storage.session.get).toHaveBeenCalledWith('credential')
    expect(storage.sync.get).not.toHaveBeenCalled()
    expect(storage.local.set).not.toHaveBeenCalled()
  })

  it('loads the key only from session storage and ignores persistent key-shaped fields', async () => {
    const storage = mockStorage({ providerSettings: { provider: 'groq', model: 'exact-model', apiKey: 'must-not-load' }, apiKey: 'also-not-a-session-key' }, { credential: { provider: 'groq', model: 'exact-model', apiKey: 'session-only-key' } })
    expect(await loadSettings()).toEqual({ provider: 'groq', model: 'exact-model', apiKey: 'session-only-key' })
    expect(storage.sync.get).not.toHaveBeenCalled()
  })

  it('requires a new key after the browser session has cleared', async () => {
    mockStorage({ providerSettings: { provider: 'groq', model: 'exact-model', apiKey: 'legacy-key' } })
    expect(await loadSettings()).toEqual({ provider: 'groq', model: 'exact-model', apiKey: '' })
  })

  it('loads one atomic session snapshot even when persistent preferences differ', async () => {
    mockStorage({ providerSettings: { provider: 'groq', model: 'stale-groq-model' } }, { credential: { provider: 'openrouter', model: 'saved-router-model', apiKey: 'router-session-key' } })
    expect(await loadSettings()).toEqual({ provider: 'openrouter', model: 'saved-router-model', apiKey: 'router-session-key' })
  })
  it('restores a complete Gemini session credential without falling back to OpenRouter', async () => {
    mockStorage({ providerSettings: { provider: 'openrouter', model: 'stale-router-model' } }, { credential: { provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' } })
    expect(await loadSettings()).toEqual({ provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' })
  })
  it('preserves Gemini preferences without restoring a key after the session is cleared', async () => {
    mockStorage({ providerSettings: { provider: 'gemini', model: 'gemini-test-model', apiKey: 'must-not-read-persistent-key' } })
    expect(await loadSettings()).toEqual({ provider: 'gemini', model: 'gemini-test-model', apiKey: '' })
  })
  it('saves Gemini keys only in the atomic session credential and keeps the provider bound to the key', async () => {
    const storage = mockStorage({ providerSettings: { provider: 'openrouter', model: 'old-model' } })
    await saveSettings({ provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' })
    expect(storage.session.set).toHaveBeenCalledWith({ credential: { provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' } })
    expect(storage.local.values.providerSettings).toEqual({ provider: 'gemini', model: 'gemini-test-model' })
    expect(JSON.stringify(storage.local.values)).not.toContain('synthetic-google-session-key')
    expect(storage.sync.set).not.toHaveBeenCalled()
    expect(await loadSettings()).toEqual({ provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' })
  })
  it('does not redirect a saved Gemini key to old provider preferences after a local write failure', async () => {
    const storage = mockStorage({ providerSettings: { provider: 'openrouter', model: 'old-model' } })
    storage.local.set.mockRejectedValueOnce(new Error('Local preferences unavailable'))
    await expect(saveSettings({ provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' })).rejects.toThrow('Local preferences unavailable')
    expect(await loadSettings()).toEqual({ provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' })
  })
  it('forgets a Gemini credential without changing the chosen provider or retaining its key', async () => {
    const storage = mockStorage({ providerSettings: { provider: 'gemini', model: 'gemini-test-model' } }, { credential: { provider: 'gemini', model: 'gemini-test-model', apiKey: 'synthetic-google-session-key' } })
    await forgetKey()
    expect(storage.session.values).toEqual({})
    expect(await loadSettings()).toEqual({ provider: 'gemini', model: 'gemini-test-model', apiKey: '' })
  })

  it('never pairs an unbound or malformed session credential with persistent provider preferences', async () => {
    for (const credential of [undefined, null, 'key-string', {}, { apiKey: 'unbound-key' }, { provider: 'groq', apiKey: 'missing-model' }, { provider: 'other-provider', model: 'model-id', apiKey: 'key' }, { provider: 'groq', model: 'model-id', apiKey: 123 }]) {
      mockStorage({ providerSettings: { provider: 'groq', model: 'preferred-model' } }, { credential, apiKey: 'legacy-unbound-key' })
      expect(await loadSettings()).toEqual({ provider: 'groq', model: 'preferred-model', apiKey: '' })
    }
  })

  it('handles malformed stored values without trusting their types', async () => {
    for (const saved of [undefined, null, true, 'settings', 7, [], { provider: 'unsupported', model: 42 }]) {
      mockStorage({ providerSettings: saved }, { credential: { secret: 'not-a-credential' } })
      expect(await loadSettings()).toEqual(emptySettings)
    }
  })

  it('bounds a stored model ID and falls back from an unknown provider', async () => {
    mockStorage({ providerSettings: { provider: 'attacker-controlled', model: 'x'.repeat(500) } }, { apiKey: false })
    expect(await loadSettings()).toEqual({ provider: 'openrouter', model: 'x'.repeat(200), apiKey: '' })
  })

  it('restricts both storage areas before saving and persists only provider/model preferences', async () => {
    const storage = mockStorage({ unrelated: 'keep-me', providerSettings: { apiKey: 'obsolete-nested-key' } })
    await saveSettings({ provider: 'groq', model: '  model-id  ', apiKey: '  test-session-only-key  ' })
    expect(storage.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(storage.order).toEqual(['session.setAccessLevel', 'local.setAccessLevel', 'session.set', 'local.set'])
    expect(storage.session.set).toHaveBeenCalledWith({ credential: { provider: 'groq', model: 'model-id', apiKey: 'test-session-only-key' } })
    expect(storage.local.set).toHaveBeenCalledWith({ providerSettings: { provider: 'groq', model: 'model-id' } })
    expect(storage.local.values).toEqual({ unrelated: 'keep-me', providerSettings: { provider: 'groq', model: 'model-id' } })
    expect(JSON.stringify(storage.local.set.mock.calls)).not.toContain('test-session-only-key')
    expect(storage.sync.set).not.toHaveBeenCalled()
  })

  it('forgets the session key without deleting persistent preferences or unrelated storage', async () => {
    const storage = mockStorage({ providerSettings: { provider: 'openrouter', model: 'model-id' } }, { credential: { provider: 'openrouter', model: 'model-id', apiKey: 'session-only-key' }, apiKey: 'legacy-unbound-key', unrelated: 'keep-me' })
    await forgetKey()
    expect(storage.session.remove).toHaveBeenCalledWith(['credential', 'apiKey'])
    expect(storage.session.values).toEqual({ unrelated: 'keep-me' })
    expect(await loadSettings()).toEqual({ provider: 'openrouter', model: 'model-id', apiKey: '' })
    expect(storage.local.remove).not.toHaveBeenCalled()
    expect(storage.local.set).not.toHaveBeenCalled()
    expect(storage.sync.remove).not.toHaveBeenCalled()
  })

  it('fails closed if access restrictions cannot be installed', async () => {
    const storage = mockStorage()
    storage.local.setAccessLevel.mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(saveSettings({ provider: 'openrouter', model: 'model-id', apiKey: 'test-session-only-key' })).rejects.toThrow('Storage unavailable')
    expect(storage.session.set).not.toHaveBeenCalled()
    expect(storage.local.set).not.toHaveBeenCalled()
  })

  it('propagates storage read/write/removal failures for the UI to report', async () => {
    const storage = mockStorage()
    storage.session.get.mockRejectedValueOnce(new Error('Cannot read session'))
    await expect(loadSettings()).rejects.toThrow('Cannot read session')
    storage.session.set.mockRejectedValueOnce(new Error('Cannot save session'))
    await expect(saveSettings({ provider: 'openrouter', model: 'model-id', apiKey: 'test-session-only-key' })).rejects.toThrow('Cannot save session')
    expect(storage.local.set).not.toHaveBeenCalled()
    storage.session.remove.mockRejectedValueOnce(new Error('Cannot remove key'))
    await expect(forgetKey()).rejects.toThrow('Cannot remove key')
  })

  it('keeps a new key bound to its own provider if updating persistent preferences fails', async () => {
    const storage = mockStorage({ providerSettings: { provider: 'groq', model: 'old-model' } })
    storage.local.set.mockRejectedValueOnce(new Error('Local preferences unavailable'))
    await expect(saveSettings({ provider: 'openrouter', model: 'new-model', apiKey: 'new-router-key' })).rejects.toThrow('Local preferences unavailable')
    expect(await loadSettings()).toEqual({ provider: 'openrouter', model: 'new-model', apiKey: 'new-router-key' })
    expect(storage.local.values.providerSettings).toEqual({ provider: 'groq', model: 'old-model' })
  })
})

describe('approved website origins', () => {
  it('normalizes comma/whitespace-separated origins, defaults and duplicates', () => {
    expect(normalizeOrigins(' HTTPS://EXAMPLE.COM:443/ , https://example.com\nhttp://localhost:8080/\t')).toEqual(['https://example.com', 'http://localhost:8080'])
    expect(normalizeOrigins('http://[::1]:8080 https://bücher.example')).toEqual(['http://[::1]:8080', 'https://xn--bcher-kva.example'])
  })

  it('accepts one through ten origins and rejects empty or oversized lists', () => {
    expect(normalizeOrigins('https://example.com')).toHaveLength(1)
    expect(normalizeOrigins(Array.from({ length: 10 }, (_, index) => `https://site${index}.example`).join('\n'))).toHaveLength(10)
    for (const input of ['', '   , ,\n', Array.from({ length: 11 }, (_, index) => `https://site${index}.example`).join(' ')]) {
      expect(() => normalizeOrigins(input)).toThrow('between 1 and 10')
    }
  })

  it.each(['chrome://settings', 'file:///tmp/file', 'javascript:alert(1)', 'data:text/plain,hello', 'ftp://example.com', 'ws://example.com', 'about:blank', 'not-a-url'])('rejects non-website scope %s', (value) => {
    expect(() => normalizeOrigins(value)).toThrow()
  })

  it.each(['https://user@example.com', 'https://user:password@example.com', 'https://:password@example.com', 'https://example.com/private', 'https://example.com/?q=secret', 'https://example.com/#section', 'https://example.com/%2f'])('rejects credentials, paths and other non-origin URL data: %s', (value) => {
    expect(() => normalizeOrigins(value)).toThrow('origins only')
  })

  it.each(['https://*', 'https://*.example.com', 'http://example.*'])('rejects wildcard hosts that would broaden Chrome site permissions: %s', (value) => {
    expect(() => normalizeOrigins(value)).toThrow()
  })
})
