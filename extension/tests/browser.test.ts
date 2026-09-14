// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pageCommand } from '../src/content'
import { cleanup, execute, observe } from '../src/browser'
import type { Action, Attachment, PageCommand, TaskScope } from '../src/types'

const origin = window.location.origin
const scope: TaskScope = { tabId: 7, origins: [origin], allowSensitive: false, allowSubmit: false, attachments: [] }
const signal = (): AbortSignal => new AbortController().signal

async function ref(name: string): Promise<string> {
  const page = await pageCommand({ kind: 'observe' })
  const match = page.observation?.elements.find(element => element.name === name)
  expect(match, `Missing page control: ${name}`).toBeTruthy()
  return match!.ref
}

async function act(action: Action, policy: Partial<Extract<PageCommand, { kind: 'act' }>> = {}) {
  return pageCommand({ kind: 'act', action, origins: [origin], allowSubmit: false, allowSensitive: false, attachments: [], ...policy })
}

beforeEach(async () => {
  await pageCommand({ kind: 'cleanup' })
  document.body.innerHTML = ''
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30, toJSON: () => ({}) })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
})

afterEach(async () => {
  await pageCommand({ kind: 'cleanup' })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('serialized page commands', () => {
  it('has no runtime dependency outside the function', async () => {
    document.body.innerHTML = '<input aria-label="Search">'
    const serialized = new Function(`return (${pageCommand.toString()})`)() as typeof pageCommand
    expect((await serialized({ kind: 'observe' })).observation?.elements[0].name).toBe('Search')
  })

  it('never fills a link, including the previously failing logo case', async () => {
    document.body.innerHTML = '<a id="logo" href="/" title="YouTube Home">Home</a><input aria-label="Search">'
    const result = await act({ type: 'fill', ref: await ref('YouTube Home'), text: 'MrBeast' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not an editable')
    expect(document.querySelector('a')?.textContent).toBe('Home')
  })

  it('uses randomized isolated references, invalidates previous observations, and does not decorate website elements', async () => {
    document.body.innerHTML = '<input aria-label="Search">'
    const oldRef = await ref('Search')
    const freshRef = await ref('Search')
    expect(freshRef).not.toBe(oldRef)
    expect(document.querySelector('[data-agent-ref]')).toBeNull()
    expect((await act({ type: 'fill', ref: oldRef, text: 'old' })).message).toContain('stale')
    expect((await act({ type: 'fill', ref: freshRef, text: 'fresh' })).ok).toBe(true)
    expect(document.querySelector('input')?.value).toBe('fresh')
  })

  it('rejects disconnected refs and fields that became read-only after inspection', async () => {
    document.body.innerHTML = '<input aria-label="Search">'
    const target = await ref('Search')
    const input = document.querySelector('input')!
    input.readOnly = true
    expect((await act({ type: 'fill', ref: target, text: 'no' })).message).toContain('read-only')
    input.remove()
    expect((await act({ type: 'click', ref: target })).message).toContain('stale')
  })

  it('rejects a reused button or input whose meaning changed since observation', async () => {
    document.body.innerHTML = '<button type="button">Continue</button><input aria-label="Search"><a href="/first">Details</a>'
    const button = await ref('Continue')
    document.querySelector('button')!.textContent = 'Delete account'
    expect((await act({ type: 'click', ref: button }, { allowSubmit: true })).message).toContain('changed its label')
    const input = await ref('Search')
    document.querySelector('input')!.type = 'password'
    expect((await act({ type: 'fill', ref: input, text: 'no' }, { allowSensitive: true })).message).toContain('changed its label')
    const anchor = await ref('Details')
    document.querySelector('a')!.href = '/different'
    expect((await act({ type: 'click', ref: anchor })).message).toContain('changed its label')
  })

  it('prioritizes current-viewport controls and nearby text after scrolling beyond the first 180 controls', async () => {
    document.body.innerHTML = Array.from({ length: 240 }, (_, index) => `<section data-index="${index}"><p>Row ${index}: ${'Detail '.repeat(150)}</p><button type="button" aria-label="Action ${index}">Action ${index}</button></section>`).join('')
    let position = 0
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const index = Number(this.closest('section')?.getAttribute('data-index') || 0)
      const top = index * 100 - position
      return { x: 10, y: top, top, left: 10, right: 110, bottom: top + 90, width: 100, height: 90, toJSON: () => ({}) }
    })
    const first = await pageCommand({ kind: 'observe' })
    expect(first.observation?.elements.some(element => element.name === 'Action 180')).toBe(false)
    position = 18_000
    vi.stubGlobal('scrollY', position)
    const later = await pageCommand({ kind: 'observe' })
    expect(later.observation?.elements[0].name).toBe('Action 180')
    expect(later.observation?.elements.some(element => element.name === 'Action 187')).toBe(true)
    expect(later.observation?.text).toContain('Row 180:')
    expect(later.observation?.text).not.toContain('Row 0:')
    expect(later.observation?.text).toContain('scroll Y 18000')
    expect(later.observation?.text).toContain('Excerpt truncated')
    expect(later.observation!.text.length).toBeLessThan(14000)
  })

  it('uses the native input setter and sends input/change events for controlled fields', async () => {
    document.body.innerHTML = '<input aria-label="Search">'
    const input = document.querySelector('input')!
    const ownSetter = vi.fn()
    const changed = vi.fn()
    const typed = vi.fn()
    Object.defineProperty(input, 'value', { configurable: true, get: () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(input), set: ownSetter })
    input.addEventListener('input', typed)
    input.addEventListener('change', changed)
    expect((await act({ type: 'fill', ref: await ref('Search'), text: 'hello' })).ok).toBe(true)
    expect(ownSetter).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(input)).toBe('hello')
    expect(typed).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
  })

  it('reports invalid input formats and field length limits instead of claiming a fill worked', async () => {
    document.body.innerHTML = '<input type="number" aria-label="Count"><input maxlength="3" aria-label="Short">'
    expect((await act({ type: 'fill', ref: await ref('Count'), text: 'not a number' })).message).toContain('did not keep')
    expect((await act({ type: 'fill', ref: await ref('Short'), text: 'long' })).message).toContain('maximum length')
  })

  it('observes and fills accessible open shadow-root controls', async () => {
    document.body.innerHTML = '<div id="host"></div>'
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<span id="label">Shadow search</span><input aria-labelledby="label">'
    expect((await act({ type: 'fill', ref: await ref('Shadow search'), text: 'inside' })).ok).toBe(true)
    expect(shadow.querySelector('input')?.value).toBe('inside')
  })

  it('excludes password and sensitive editor values and gates sensitive filling', async () => {
    document.body.innerHTML = '<p>Public information</p><input type="password" value="private-password" aria-label="Password"><textarea autocomplete="current-password">private-area</textarea><div contenteditable="true" aria-label="Secret key">private-key</div><p hidden>invisible</p>'
    const page = await pageCommand({ kind: 'observe' })
    expect(JSON.stringify(page)).not.toMatch(/private-password|private-area|private-key|invisible/)
    expect(page.observation?.text).toContain('Public information')
    const password = page.observation!.elements.find(element => element.type === 'password')!
    expect(password.sensitive).toBe(true)
    expect((await act({ type: 'fill', ref: password.ref, text: 'approved-secret' })).message).toContain('not approved')
    expect((await act({ type: 'fill', ref: password.ref, text: 'approved-secret' }, { allowSensitive: true })).ok).toBe(true)
    expect((await pageCommand({ kind: 'observe' })).observation?.text).not.toContain('approved-secret')
  })

  it('blocks sensitive fields even when their type is text', async () => {
    document.body.innerHTML = '<input autocomplete="cc-number" aria-label="Number">'
    const page = await pageCommand({ kind: 'observe' })
    expect(page.observation?.elements[0].sensitive).toBe(true)
    expect((await act({ type: 'fill', ref: page.observation!.elements[0].ref, text: '1234' })).ok).toBe(false)
  })

  it('does not use unlabeled textarea or contenteditable values as accessible names', async () => {
    document.body.innerHTML = '<textarea>private-draft</textarea><div contenteditable="true">private-editor</div><label>Secret token<textarea autocomplete="current-password">private-nested</textarea></label>'
    const page = await pageCommand({ kind: 'observe' })
    expect(JSON.stringify(page)).not.toMatch(/private-draft|private-editor|private-nested/)
    expect(page.observation?.elements).toHaveLength(3)
  })

  it('handles textareas, contenteditable and native selects without treating checkboxes as text', async () => {
    document.body.innerHTML = '<textarea aria-label="Notes"></textarea><div contenteditable="true" aria-label="Editor"></div><input type="checkbox" aria-label="Agree"><select aria-label="City"><option value="a">A</option><option value="b">B</option><option value="c" disabled>C</option></select>'
    expect((await act({ type: 'fill', ref: await ref('Notes'), text: 'note' })).ok).toBe(true)
    expect((await act({ type: 'fill', ref: await ref('Editor'), text: 'edited' })).ok).toBe(true)
    expect((await act({ type: 'fill', ref: await ref('Agree'), text: 'true' })).ok).toBe(false)
    const city = await ref('City')
    expect((await act({ type: 'select', ref: city, value: 'b' })).ok).toBe(true)
    expect(document.querySelector('select')?.value).toBe('b')
    expect((await act({ type: 'select', ref: city, value: 'c' })).ok).toBe(false)
  })

  it('blocks external and script links and forms targeting unapproved origins', async () => {
    document.body.innerHTML = '<a href="https://unapproved.example/">External</a><a href="javascript:void(0)">Script</a><form action="https://unapproved.example/"><input aria-label="Outside form"></form>'
    expect((await act({ type: 'click', ref: await ref('External') })).message).toContain('outside')
    expect((await act({ type: 'click', ref: await ref('Script') })).message).toContain('outside')
    expect((await act({ type: 'fill', ref: await ref('Outside form'), text: 'no' })).message).toContain('outside')
  })

  it('blocks cross-tab links, direct downloads, submit buttons and consequential controls by default', async () => {
    document.body.innerHTML = '<a href="/other" target="_blank">New tab</a><a href="/file" download>Download</a><form><button>Submit</button></form><button type="button">Delete account</button><button type="button">Log in</button>'
    expect((await act({ type: 'click', ref: await ref('New tab') })).message).toContain('another tab')
    expect((await act({ type: 'click', ref: await ref('Download') })).message).toContain('downloads')
    expect((await act({ type: 'click', ref: await ref('Submit') })).message).toContain('not approved')
    expect((await act({ type: 'click', ref: await ref('Delete account') })).message).toContain('not approved')
    expect((await act({ type: 'click', ref: await ref('Log in') })).message).toContain('not approved')
    const click = vi.fn()
    document.querySelector('button[type="button"]')!.addEventListener('click', click)
    expect((await act({ type: 'click', ref: await ref('Delete account') }, { allowSubmit: true })).ok).toBe(true)
    expect(click).toHaveBeenCalledOnce()
  })

  it('requires approval for Enter and accepts only bounded scrolling', async () => {
    document.body.innerHTML = '<input aria-label="Search">'
    expect((await act({ type: 'press', ref: await ref('Search'), key: 'Enter' })).ok).toBe(false)
    expect((await act({ type: 'scroll', direction: 'down', amount: 2001 })).ok).toBe(false)
    expect((await act({ type: 'scroll', direction: 'down', amount: 600 })).ok).toBe(true)
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 600, behavior: 'instant' })
  })

  it('only uploads approved attachment bytes to compatible file inputs', async () => {
    document.body.innerHTML = '<input aria-label="Normal"><input type="file" aria-label="Upload" accept=".txt" style="display:none">'
    const file: Attachment = { id: 'approved', name: 'notes.txt', type: 'text/plain', size: 5, base64: btoa('hello') }
    expect((await act({ type: 'upload', ref: await ref('Normal'), attachmentIds: [file.id] }, { attachments: [file] })).ok).toBe(false)
    const upload = await ref('Upload')
    expect((await act({ type: 'upload', ref: upload, attachmentIds: ['unknown'] }, { attachments: [file] })).message).toContain('not approved')
    expect((await act({ type: 'upload', ref: upload, attachmentIds: [file.id, file.id] }, { attachments: [file] })).ok).toBe(false)
    expect((await act({ type: 'upload', ref: upload, attachmentIds: [file.id] }, { attachments: [{ ...file, name: 'bad.exe', type: 'application/octet-stream' }] })).message).toContain('not accepted')
    expect((await act({ type: 'upload', ref: upload, attachmentIds: [file.id] }, { attachments: [{ ...file, size: 99 }] })).message).toContain('size')
    let assigned: File[] = []
    const input = document.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, set: value => { assigned = value } })
    vi.stubGlobal('DataTransfer', class {
      files: File[] = []
      items = { add: (value: File): void => { this.files.push(value) } }
    })
    expect((await act({ type: 'upload', ref: upload, attachmentIds: [file.id] }, { attachments: [file] })).ok).toBe(true)
    expect(assigned[0].name).toBe('notes.txt')
    expect(assigned[0].size).toBe(5)
  })

  it('removes the indicator and all element refs on cleanup', async () => {
    document.body.innerHTML = '<input aria-label="Search">'
    const target = await ref('Search')
    await act({ type: 'fill', ref: target, text: 'test' })
    expect(document.documentElement.querySelector('[aria-hidden="true"]')).not.toBeNull()
    await pageCommand({ kind: 'cleanup' })
    expect(document.documentElement.querySelector('[aria-hidden="true"]')).toBeNull()
    expect((await act({ type: 'fill', ref: target, text: 'again' })).message).toContain('stale')
  })
})

describe('scoped Chrome browser controller', () => {
  const installChrome = () => {
    const chromeMock = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 7, active: true, url: `${origin}/`, status: 'complete' }),
        query: vi.fn().mockResolvedValue([{ id: 7 }]),
        update: vi.fn().mockResolvedValue({ id: 7 }),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: { ok: true, message: 'Inspected', observation: { url: `${origin}/`, title: 'Page', text: 'Public', elements: [] } } }]),
      },
    }
    vi.stubGlobal('chrome', chromeMock)
    return chromeMock
  }

  it('observes only the approved active tab in the isolated world', async () => {
    const chromeMock = installChrome()
    expect((await observe(scope, signal())).tabId).toBe(7)
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, world: 'ISOLATED', func: pageCommand, args: [{ kind: 'observe' }] })
  })

  it('stops before injection when the user switches tabs', async () => {
    const chromeMock = installChrome()
    chromeMock.tabs.query.mockResolvedValue([{ id: 99 }])
    await expect(execute({ type: 'click', ref: 'anything' }, scope, signal())).rejects.toThrow('active tab changed')
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('rejects unapproved navigation and restricted pages without any tab update', async () => {
    const chromeMock = installChrome()
    await expect(execute({ type: 'navigate', url: 'https://outside.example/' }, scope, signal())).rejects.toThrow('approved')
    await expect(execute({ type: 'navigate', url: 'chrome://settings' }, scope, signal())).rejects.toThrow('internal pages')
    expect(chromeMock.tabs.update).not.toHaveBeenCalled()
    chromeMock.tabs.get.mockResolvedValue({ id: 7, active: true, url: `${origin}/`, pendingUrl: 'https://outside.example/' })
    await expect(observe(scope, signal())).rejects.toThrow('approved')
  })

  it('rejects stale approvals when observed navigation changes origin', async () => {
    const chromeMock = installChrome()
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { ok: true, message: '', observation: { url: 'https://outside.example/', title: '', text: '', elements: [] } } }])
    await expect(observe(scope, signal())).rejects.toThrow('approved')
  })

  it('does not send unrelated attachment contents to page commands', async () => {
    const chromeMock = installChrome()
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { ok: false, message: 'Fixture' } }])
    const files: Attachment[] = [{ id: 'a', name: 'one.txt', type: 'text/plain', size: 1, base64: 'YQ==' }, { id: 'b', name: 'two.txt', type: 'text/plain', size: 1, base64: 'Yg==' }]
    await execute({ type: 'upload', ref: 'target', attachmentIds: ['a'] }, { ...scope, attachments: files }, signal())
    expect(chromeMock.scripting.executeScript.mock.calls[0][0].args[0].attachments).toEqual([files[0]])
    await execute({ type: 'fill', ref: 'target', text: 'normal' }, { ...scope, attachments: files }, signal())
    expect(chromeMock.scripting.executeScript.mock.calls[1][0].args[0].attachments).toEqual([])
  })

  it('honors an already-aborted task and cancellation between permission lookup and injection', async () => {
    const chromeMock = installChrome()
    const controller = new AbortController()
    controller.abort()
    await expect(observe(scope, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(chromeMock.tabs.get).not.toHaveBeenCalled()
    const duringLookup = new AbortController()
    chromeMock.tabs.get.mockImplementation(async () => { duringLookup.abort(); return { id: 7, active: true, url: `${origin}/` } })
    await expect(execute({ type: 'navigate', url: `${origin}/next` }, scope, duringLookup.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(chromeMock.tabs.update).not.toHaveBeenCalled()
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('gives a friendly error for inaccessible pages and tolerates closed-tab cleanup', async () => {
    const chromeMock = installChrome()
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('Cannot access contents of url'))
    await expect(observe(scope, signal())).rejects.toThrow('Chrome blocked access')
    await expect(cleanup(7)).resolves.toBeUndefined()
  })
})
