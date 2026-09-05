import type { BrowserAction, BrowserElement } from '../shared/types'

export interface NavigationDecision {
  allowed: boolean
  host?: string
  normalizedUrl?: string
  reason?: string
}

export interface RiskDecision {
  approvalRequired: boolean
  category?: string
  risk?: 'medium' | 'high'
  title?: string
  reason?: string
  preview?: string
  rememberable?: boolean
}

/** Capabilities are granted once at task start, then checked for each browser action. */
export function requiredActionCapabilities(
  action: BrowserAction,
  element?: BrowserElement
): Array<'submitForms' | 'sensitiveInputs' | 'consequentialActions'> {
  const required = new Set<'submitForms' | 'sensitiveInputs' | 'consequentialActions'>()
  const descriptor = [element?.name, element?.href, element?.type].filter(Boolean).join(' ')
  const typing = action.name === 'type_text' || action.name === 'press_key'
  if (typing && (element?.sensitive || containsAny(descriptor, SENSITIVE_WORDS))) {
    required.add('sensitiveInputs')
  }
  const enter = action.name === 'press_key' && /(?:^|\+)enter$/i.test(String(action.arguments.key ?? ''))
  if (action.name === 'click' || enter) {
    const link = element?.tag === 'a' || element?.role === 'link'
    const actionLink = /^javascript:/i.test(element?.href ?? '') || /\/(?:delete|remove|erase|send|publish|unsubscribe|checkout)(?:[/?#]|$)/i.test(element?.href ?? '')
    if ((!link || actionLink) && /\b(?:buy|purchase|pay|payment|place order|confirm order|delete|deletion|remove|erase|send|publish|post|book|reserve|transfer|unsubscribe|create account|checkout)\b/i.test(descriptor)) {
      required.add('consequentialActions')
    }
    const search = element?.type === 'search' || /\b(?:search|find)\b/i.test(element?.name ?? '')
    if (!search && (enter || element?.type === 'submit' || ((!link || actionLink) && /\b(?:submit|sign in|log in|login|sign up|register)\b/i.test(descriptor)))) {
      required.add('submitForms')
    }
  }
  return [...required]
}

const CONSEQUENCE_WORDS = [
  'buy',
  'purchase',
  'pay',
  'place order',
  'confirm order',
  'delete',
  'remove',
  'send',
  'submit',
  'publish',
  'post',
  'book',
  'reserve',
  'transfer',
  'sign in',
  'log in',
  'create account',
  'unsubscribe'
]

const SENSITIVE_WORDS = [
  'password',
  'passcode',
  'credit card',
  'card number',
  'cvv',
  'cvc',
  'social security',
  'ssn',
  'otp',
  'one-time code',
  'security code'
]

const DOWNLOAD_WORDS = ['download', 'export', 'save file', 'save as', 'get pdf', 'get csv']

export function normalizeAllowlistEntry(entry: string): string {
  const trimmed = entry.trim().toLowerCase().replace(/^\*\./, '')
  if (!trimmed) return ''

  try {
    const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`
    return new URL(withScheme).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isHostAllowed(host: string, allowlist: string[]): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '')
  return allowlist
    .map(normalizeAllowlistEntry)
    .filter(Boolean)
    .some((allowed) => normalizedHost === allowed || normalizedHost.endsWith(`.${allowed}`))
}

export function evaluateNavigation(rawUrl: string, allowlist: string[]): NavigationDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: 'The URL is invalid.' }
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { allowed: false, reason: `The ${url.protocol} scheme is blocked.` }
  }

  if (url.username || url.password) {
    return { allowed: false, reason: 'URLs containing embedded credentials are blocked.' }
  }

  const host = url.hostname.toLowerCase()
  return {
    allowed: isHostAllowed(host, allowlist),
    host,
    normalizedUrl: url.toString(),
    reason: isHostAllowed(host, allowlist)
      ? undefined
      : `${host} is not in this run's domain allowlist.`
  }
}

export function isInPageActionHref(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === 'javascript:'
  } catch {
    return false
  }
}

function containsAny(value: string, words: string[]): boolean {
  const normalized = value.toLowerCase()
  return words.some((word) => normalized.includes(word))
}

export function evaluateActionRisk(
  action: BrowserAction,
  element?: BrowserElement
): RiskDecision {
  const descriptor = [element?.name, element?.type, element?.href, element?.role]
    .filter(Boolean)
    .join(' ')

  if (action.name === 'upload_file') {
    const filePath = String(action.arguments.path ?? '')
    return {
      approvalRequired: true,
      category: `upload:${filePath}`,
      risk: 'high',
      title: 'Upload this local file?',
      reason: 'Uploading sends a file from this computer to the current website.',
      preview: `Upload ${filePath || '(missing path)'} into “${element?.name || 'file input'}”`,
      rememberable: false
    }
  }

  if (action.name === 'download') {
    return {
      approvalRequired: true,
      category: 'download',
      risk: 'medium',
      title: 'Download this file?',
      reason: 'The website will write a file into this run’s artifact folder.',
      preview: `Download from “${element?.name || element?.href || 'unnamed control'}”`,
      rememberable: false
    }
  }

  if (action.name === 'type_text' && (element?.sensitive || containsAny(descriptor, SENSITIVE_WORDS))) {
    return {
      approvalRequired: true,
      category: 'sensitive_input',
      risk: 'high',
      title: 'Share sensitive information?',
      reason: 'The agent wants to type into a field that appears to contain a password, payment detail, or verification code.',
      preview: `Type into “${element?.name || element?.type || 'sensitive field'}” (value hidden)`,
      rememberable: false
    }
  }

  if (action.name === 'click' && containsAny(descriptor, CONSEQUENCE_WORDS)) {
    return {
      approvalRequired: true,
      category: 'consequential_click',
      risk: 'high',
      title: 'Allow consequential click?',
      reason: 'This click may submit data, communicate externally, make a purchase, or delete something.',
      preview: `Click “${element?.name || element?.href || 'unnamed control'}”`,
      rememberable: false
    }
  }

  if (action.name === 'click' && containsAny(descriptor, DOWNLOAD_WORDS)) {
    return {
      approvalRequired: true,
      category: 'download_like_click',
      risk: 'medium',
      title: 'This may download a file',
      reason: 'Use the dedicated download action so the file is captured and audited safely.',
      preview: `Click “${element?.name || element?.href || 'download control'}”`,
      rememberable: false
    }
  }

  if (action.name === 'press_key' && String(action.arguments.key).toLowerCase() === 'enter') {
    return {
      approvalRequired: true,
      category: 'submit_key',
      risk: 'medium',
      title: 'Allow Enter key?',
      reason: 'Pressing Enter can submit a form or trigger an irreversible action.',
      preview: 'Press Enter on the current page',
      rememberable: true
    }
  }

  return { approvalRequired: false }
}
