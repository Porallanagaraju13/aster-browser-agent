import type { AgentEvent } from '../shared/types'

const TASK_VALUE_PATTERN = /\b(?:password|passcode|pwd|pin|otp|api[\s_-]?key|access[\s_-]?token|bearer[\s_-]?token|secret|mobile\s+or\s+zid|zid|login\s+id|username|user\s+id)\b["']?\s*(?::|=|\bis\b)\s*(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/gi
const SECRET_LABEL_PATTERN = /(\b(?:password|passcode|pwd|pin|otp|api[\s_-]?key|access[\s_-]?token|bearer[\s_-]?token|secret|mobile\s+or\s+zid|zid|login\s+id|username|user\s+id)\b["']?\s*(?::|=|\bis\b)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const URL_SECRET_PATTERN = /([?&](?:password|pwd|token|api[_-]?key|access[_-]?token)=)[^&#\s]+/gi
const BEARER_PATTERN = /(authorization\s*:\s*bearer\s+)[^\s,;]+/gi
const PROVIDER_KEY_PATTERN = /\b(?:nvapi-|sk-or-v1-|gsk_|sk-proj-)[A-Za-z0-9_-]{8,}|\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractSensitiveTaskValues(task: string): string[] {
  const values = new Set<string>()
  for (const match of task.matchAll(TASK_VALUE_PATTERN)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (value.length >= 3) values.add(value)
  }
  return [...values]
}

export function redactSensitiveText(
  value: string | undefined,
  sensitiveValues: readonly string[] = []
): string | undefined {
  if (value === undefined) return undefined

  let redacted = value
    .replace(PROVIDER_KEY_PATTERN, '[REDACTED]')
    .replace(SECRET_LABEL_PATTERN, '$1[REDACTED]')
    .replace(URL_SECRET_PATTERN, '$1[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')

  for (const secret of sensitiveValues) {
    if (secret.length < 3) continue
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]')
  }
  return redacted
}

function redactUnknown(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === 'string') return redactSensitiveText(value, sensitiveValues)
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, sensitiveValues))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactUnknown(nested, sensitiveValues)])
    )
  }
  return value
}

export function redactAgentEvent(
  event: AgentEvent,
  sensitiveValues: readonly string[] = []
): AgentEvent {
  return {
    ...event,
    title: redactSensitiveText(event.title, sensitiveValues) ?? '',
    detail: redactSensitiveText(event.detail, sensitiveValues),
    metadata: event.metadata
      ? (redactUnknown(event.metadata, sensitiveValues) as Record<string, unknown>)
      : undefined
  }
}
