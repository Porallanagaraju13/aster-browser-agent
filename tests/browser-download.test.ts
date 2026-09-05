import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserController } from '../src/main/browser-controller'

describe('download failure cleanup', () => {
  it('removes its pending download listener and timeout when the target disappears before clicking', async () => {
    vi.useFakeTimers()
    const emitter = new EventEmitter()
    const locator = { first: () => locator }
    const page = Object.assign(emitter, {
      isClosed: () => false,
      locator: () => locator,
      waitForEvent: (name: string) => new Promise((resolve, reject) => {
        emitter.once(name, resolve)
        setTimeout(() => reject(new Error('download timeout')), 15_000)
      })
    })
    const frame = { isDetached: () => false, locator: () => locator }
    const controller = new BrowserController({ profileDir: 'unused', artifactDir: 'unused', allowlist: [], onNotice: () => undefined })
    Reflect.set(controller, 'activePage', page)
    Reflect.set(controller, 'refFrames', new WeakMap([[page, new Map([['e1', frame]])]]))
    Reflect.set(controller, 'pointAt', async () => { throw new Error('The download target was removed.') })
    try {
      const result = await controller.execute({ name: 'download', arguments: { ref: 'e1' }, callId: 'failed-download' })
      expect(result.ok).toBe(false)
      expect(result.message).toContain('target was removed')
      expect(emitter.listenerCount('download')).toBe(0)
      expect(emitter.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      emitter.removeAllListeners()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
