import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRunner } from '../src/main/agent-runner'

function runner(): AgentRunner {
  const root = path.join(os.tmpdir(), 'aster-runner-validation')
  return new AgentRunner({
    artifactsRoot: path.join(root, 'artifacts'),
    profileDir: path.join(root, 'profile'),
    emitEvent: () => undefined,
    emitApproval: () => undefined,
    emitLiveFrame: () => undefined
  })
}

const validInput = {
  apiKey: 'test-key',
  provider: 'google' as const,
  model: 'test-model',
  maxSteps: 60,
  allowlist: [] as string[]
}

describe('AgentRunner input validation', () => {
  it('rejects an empty task before creating a browser run', async () => {
    await expect(runner().start({ ...validInput, task: '   ' })).resolves.toEqual({
      ok: false,
      error: 'Describe what the browser agent should accomplish.'
    })
  })

  it('rejects tasks beyond the renderer limit', async () => {
    const result = await runner().start({ ...validInput, task: 'x'.repeat(2_001) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('2,000')
  })
})
