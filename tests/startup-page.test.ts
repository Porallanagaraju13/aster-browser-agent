import { describe, expect, it } from 'vitest'
import { STARTUP_PAGE_DOCUMENT, STARTUP_PAGE_TITLE } from '../src/main/startup-page'

describe('static local browser startup screen', () => {
  it('has no scripts, remote assets, links, inputs or provider/task interpolation', () => {
    expect(STARTUP_PAGE_DOCUMENT.title).toBe(STARTUP_PAGE_TITLE)
    const markup = STARTUP_PAGE_DOCUMENT.head + STARTUP_PAGE_DOCUMENT.body
    expect(markup).toContain("default-src 'none'")
    expect(markup).toContain("form-action 'none'")
    expect(markup).not.toMatch(/<script|<iframe|<input|<button|<a\s|\bsrc\s*=|\bhref\s*=|url\s*\(|https?:\/\//i)
    expect(markup).not.toMatch(/OpenRouter|Groq|Gemini|NVIDIA|apiKey|\$\{|Bearer\s/i)
    expect(Object.isFrozen(STARTUP_PAGE_DOCUMENT)).toBe(true)
  })

  it('explains that a ready browser is not proof of successful AI inference', () => {
    expect(STARTUP_PAGE_DOCUMENT.body).toContain('No website has been opened yet')
    expect(STARTUP_PAGE_DOCUMENT.body).toContain('Activity panel')
    expect(STARTUP_PAGE_DOCUMENT.body).toContain('not a website or proof that the AI connection succeeded')
    expect(STARTUP_PAGE_DOCUMENT.body).toContain('No task details or credentials are displayed here')
  })
})
