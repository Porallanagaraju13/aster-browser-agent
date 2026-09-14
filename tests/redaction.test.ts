import { describe, expect, it } from 'vitest'
import {
  extractSensitiveTaskValues,
  redactAgentEvent,
  redactSensitiveText
} from '../src/main/redaction'

describe('task credential redaction', () => {
  it('redacts task-provided login identifiers and passwords', () => {
    const task = 'Open the portal. Mobile or ZiD: 2025550100 password: Example\\@19'
    const values = extractSensitiveTaskValues(task)
    const result = redactSensitiveText(task, values) ?? ''

    expect(result).not.toContain('2025550100')
    expect(result).not.toContain('Example\\@19')
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2)
  })

  it('keeps unrelated distributor contact details visible', () => {
    const result = redactSensitiveText('ABC Distributor — Mobile: 2025550101', ['2025550100'])
    expect(result).toBe('ABC Distributor — Mobile: 2025550101')
  })

  it('redacts credentials repeated by model messages and nested metadata', () => {
    const event = redactAgentEvent(
      {
        id: 'event-1',
        runId: 'run-1',
        type: 'thought',
        timestamp: '2026-09-02T00:00:00.000Z',
        title: 'Using 2025550100',
        detail: 'Authorization: Bearer private-token',
        metadata: { nested: { value: 'Example\\@19' } }
      },
      ['2025550100', 'Example\\@19']
    )

    expect(JSON.stringify(event)).not.toContain('2025550100')
    expect(JSON.stringify(event)).not.toContain('Example\\@19')
    expect(JSON.stringify(event)).not.toContain('private-token')
  })

  it.each(['nvapi-synthetic-test-key-123', 'gsk_synthetic_test_key_123', 'sk-or-v1-synthetic-test-key-123', `AIza${'A'.repeat(34)}-`, `AIza${'A'.repeat(34)}_`])('redacts recognizable provider keys even when not the active configured key', (key) => {
    expect(redactSensitiveText(`Untrusted page text: ${key}`)).toBe('Untrusted page text: [REDACTED]')
  })
})
