import { describe, expect, it } from 'vitest'
import type { BrowserAction, BrowserElement } from '../src/shared/types'
import {
  evaluateActionRisk,
  evaluateNavigation,
  isHostAllowed,
  isInPageActionHref,
  normalizeAllowlistEntry
} from '../src/main/safety'

const action = (
  name: BrowserAction['name'],
  args: Record<string, unknown> = {}
): BrowserAction => ({ name, arguments: args, callId: 'call-1' })

const element = (overrides: Partial<BrowserElement> = {}): BrowserElement => ({
  ref: 'e1',
  tag: 'button',
  role: 'button',
  name: 'Continue',
  disabled: false,
  sensitive: false,
  ...overrides
})

describe('domain policy', () => {
  it('normalizes URLs and wildcard-like entries to host names', () => {
    expect(normalizeAllowlistEntry('https://Docs.Example.com/path')).toBe('docs.example.com')
    expect(normalizeAllowlistEntry('*.example.com')).toBe('example.com')
  })

  it('allows an exact host and its subdomains without allowing suffix tricks', () => {
    expect(isHostAllowed('example.com', ['example.com'])).toBe(true)
    expect(isHostAllowed('docs.example.com', ['example.com'])).toBe(true)
    expect(isHostAllowed('evilexample.com', ['example.com'])).toBe(false)
  })

  it('blocks unsupported schemes and embedded credentials', () => {
    expect(evaluateNavigation('file:///etc/passwd', ['example.com']).allowed).toBe(false)
    expect(evaluateNavigation('javascript:alert(1)', ['example.com']).allowed).toBe(false)
    expect(evaluateNavigation('https://user:secret@example.com', ['example.com']).allowed).toBe(false)
  })

  it('requires approval for a valid URL on a new domain', () => {
    const decision = evaluateNavigation('https://ai.google.dev/gemini-api', ['localhost'])
    expect(decision.allowed).toBe(false)
    expect(decision.host).toBe('ai.google.dev')
    expect(decision.normalizedUrl).toBe('https://ai.google.dev/gemini-api')
  })
})

describe('in-page action links', () => {
  it('recognizes JavaScript-backed controls without treating them as cross-site navigation', () => {
    expect(isInPageActionHref('javascript:void(0)')).toBe(true)
    expect(isInPageActionHref('javascript:showContact(123)')).toBe(true)
  })

  it('does not classify external handlers or web links as in-page actions', () => {
    expect(isInPageActionHref('https://example.com/details')).toBe(false)
    expect(isInPageActionHref('tel:+15551234567')).toBe(false)
    expect(isInPageActionHref('mailto:test@example.com')).toBe(false)
  })
})

describe('action risk policy', () => {
  it('gates consequential clicks', () => {
    const decision = evaluateActionRisk(action('click', { ref: 'e1' }), element({ name: 'Place order' }))
    expect(decision.approvalRequired).toBe(true)
    expect(decision.risk).toBe('high')
  })

  it('gates typing into sensitive fields and hides the value from the preview', () => {
    const decision = evaluateActionRisk(
      action('type_text', { ref: 'e1', text: 'super-secret' }),
      element({ tag: 'input', role: 'input', name: 'Password', type: 'password', sensitive: true })
    )
    expect(decision.approvalRequired).toBe(true)
    expect(decision.preview).not.toContain('super-secret')
  })

  it('gates Enter but leaves ordinary browsing automatic', () => {
    expect(evaluateActionRisk(action('press_key', { key: 'Enter' })).approvalRequired).toBe(true)
    expect(evaluateActionRisk(action('press_key', { key: 'Tab' })).approvalRequired).toBe(false)
    expect(evaluateActionRisk(action('scroll', { direction: 'down', amount: 500 })).approvalRequired).toBe(false)
  })

  it('always gates local file uploads and audited downloads', () => {
    const upload = evaluateActionRisk(
      action('upload_file', { ref: 'e1', path: 'C:\\work\\report.pdf' }),
      element({ tag: 'input', type: 'file', name: 'Attach report' })
    )
    const download = evaluateActionRisk(
      action('download', { ref: 'e2' }),
      element({ tag: 'a', role: 'link', name: 'Download invoice' })
    )

    expect(upload.approvalRequired).toBe(true)
    expect(upload.risk).toBe('high')
    expect(download.approvalRequired).toBe(true)
  })
})
