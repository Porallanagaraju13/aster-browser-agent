import type { Action, ActionResult, Observation, PageCommand, PageReply, TaskScope } from './types'
import { pageCommand } from './content'

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Task stopped.', 'AbortError')
}

function approvedUrl(raw: string, scope: TaskScope): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Use a complete HTTP(S) website URL.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Chrome internal pages, extension pages, local files, and credential-bearing URLs cannot be automated. Open a normal HTTP(S) website.')
  if (!scope.origins.includes(url.origin)) throw new Error('The page is outside this task’s approved website origins. Start a new task to approve another website.')
  if (url.hostname === 'chromewebstore.google.com' || url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')) throw new Error('Chrome does not allow extensions to automate the Chrome Web Store. Open a different website.')
  return url
}

async function scopedTab(scope: TaskScope, signal: AbortSignal): Promise<chrome.tabs.Tab> {
  aborted(signal)
  const [tab, active] = await Promise.all([chrome.tabs.get(scope.tabId), chrome.tabs.query({ active: true, lastFocusedWindow: true })])
  aborted(signal)
  if (!tab.active || active[0]?.id !== scope.tabId) throw new Error('The active tab changed. The task stopped so it will not act while you use another tab.')
  if (!tab.url) throw new Error('This tab is not accessible. Grant website access and start the task again.')
  approvedUrl(tab.pendingUrl || tab.url, scope)
  return tab
}

async function inject(tabId: number, command: PageCommand, signal?: AbortSignal): Promise<PageReply> {
  if (signal) aborted(signal)
  try {
    const replies = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: pageCommand, args: [command] })
    if (signal) aborted(signal)
    if (!replies[0]?.result) throw new Error('The page changed before the browser command completed. Inspect it again.')
    return replies[0].result
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Task stopped.', 'AbortError')
    const message = error instanceof Error ? error.message : String(error)
    if (/Cannot access|Missing host permission|Cannot access contents|extensions gallery|chrome:\/\//i.test(message)) throw new Error('Chrome blocked access to this page. Open a normal website and approve its origin when starting the task.')
    throw error
  }
}

async function settle(scope: TaskScope, signal: AbortSignal): Promise<void> {
  // Cancellable, bounded settling. SPA mutations do not trigger page reloads.
  const end = Date.now() + 7000
  await delay(250, signal)
  while (Date.now() < end) {
    const tab = await scopedTab(scope, signal)
    if (tab.status !== 'loading') return
    await delay(150, signal)
  }
  throw new Error('The page is still loading. Wait for it to finish, then start the task again.')
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  aborted(signal)
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(new DOMException('Task stopped.', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function observe(scope: TaskScope, signal: AbortSignal): Promise<Observation> {
  await scopedTab(scope, signal)
  const result = await inject(scope.tabId, { kind: 'observe' }, signal)
  if (!result.ok || !result.observation) throw new Error(result.message)
  approvedUrl(result.observation.url, scope)
  return { ...result.observation, tabId: scope.tabId }
}

export async function execute(action: Action, scope: TaskScope, signal: AbortSignal): Promise<ActionResult> {
  await scopedTab(scope, signal)
  if (action.type === 'inspect') {
    await observe(scope, signal)
    return { ok: true, message: 'Page inspected.' }
  }
  if (action.type === 'navigate') {
    const url = approvedUrl(action.url, scope)
    aborted(signal)
    await chrome.tabs.update(scope.tabId, { url: url.href })
    await settle(scope, signal)
    return { ok: true, message: `Navigated to ${url.origin}.` }
  }
  if (['save_file', 'save_spreadsheet', 'finish'].includes(action.type)) return { ok: false, message: 'File generation and finish are handled by the agent, not the webpage.' }
  // Never send unrelated files to an injected command; include only approved requested files.
  const attachments = action.type === 'upload' ? scope.attachments.filter(file => action.attachmentIds.includes(file.id)) : []
  const result = await inject(scope.tabId, { kind: 'act', action, origins: scope.origins, allowSubmit: scope.allowSubmit, allowSensitive: scope.allowSensitive, attachments }, signal)
  if (result.ok) await settle(scope, signal)
  return { ok: result.ok, message: result.message }
}

export async function cleanup(tabId: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      inject(tabId, { kind: 'cleanup' }),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) }),
    ])
  } catch { /* Tab may already be closed or navigated. */ }
  finally { if (timer) clearTimeout(timer) }
}
