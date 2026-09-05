import path from 'node:path'
import type { BrowserAction, BrowserElement, TaskCapabilities } from '../shared/types'
import { requiredActionCapabilities } from './safety'
import { requestedUploadPaths } from './upload-files'

export interface ScopeDecision {
  allowed: boolean
  reason?: string
}

/**
 * One human approval grants browser actions for one task. This object never
 * prompts again; it either allows an action inside that scope or denies it.
 */
export class TaskPermissionScope {
  private granted = false
  private readonly normalizedTask: string
  private readonly attachmentPaths: Set<string>

  constructor(
    readonly task: string,
    attachmentPaths: string[] = [],
    private readonly capabilities: Partial<TaskCapabilities> = {}
  ) {
    this.normalizedTask = this.normalize(task)
    this.attachmentPaths = new Set(attachmentPaths.map((filePath) => this.normalize(path.resolve(filePath))))
  }

  grant(): void {
    this.granted = true
  }

  isGranted(): boolean {
    return this.granted
  }

  authorize(action: BrowserAction, element?: BrowserElement): ScopeDecision {
    if (!this.granted) {
      return { allowed: false, reason: 'The task has not been approved.' }
    }

    if (action.name === 'upload_file') {
      if (this.isReadOnly() || this.deniedClause(/\bupload\w*\b/)) {
        return { allowed: false, reason: 'The task explicitly disallows uploading files.' }
      }
      try {
        for (const requestedPath of requestedUploadPaths(action.arguments)) {
          const normalizedPath = this.normalize(path.resolve(requestedPath))
          if (!this.attachmentPaths.has(normalizedPath) && !this.taskContainsExactPath(normalizedPath)) {
            return {
              allowed: false,
              reason: `Upload blocked: the exact local path “${requestedPath}” was not attached or included in the approved task.`
            }
          }
        }
      } catch (error) {
        return { allowed: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    const required = requiredActionCapabilities(action, element)
    const enter = action.name === 'press_key' && /(?:^|\+)enter$/i.test(String(action.arguments.key ?? ''))
    if ((enter || (action.name === 'click' && element?.type === 'submit')) && this.explicitlyDenied('submitForms', element)) {
      return { allowed: false, reason: 'The task explicitly disallows form submission.' }
    }
    const labels = {
      submitForms: 'Submitting forms',
      sensitiveInputs: 'Entering sensitive information',
      consequentialActions: 'Purchases, messages, publishing, or destructive actions'
    }
    for (const capability of required) {
      if (this.isReadOnly() || this.explicitlyDenied(capability, element)) {
        return { allowed: false, reason: `${labels[capability]} is prohibited by the task instructions.` }
      }
      if (this.capabilities[capability] !== true) {
        return { allowed: false, reason: `${labels[capability]} was not enabled in this task's initial approval.` }
      }
    }

    return { allowed: true }
  }

  approvalPreview(): string {
    return [
      `Task: ${this.task}`,
      '',
      'One approval covers this run:',
      this.capabilities.unrestrictedNavigation
        ? '• visit HTTP(S) sites needed for the task, including linked sites'
        : '• visit only the domains included in this task and its allowed-domain list',
      '• browse, search, and enter ordinary text',
      `• submit forms: ${this.capabilities.submitForms ? 'enabled' : 'disabled'}`,
      `• use sensitive fields: ${this.capabilities.sensitiveInputs ? 'enabled' : 'disabled'}`,
      `• consequential actions (purchase, send, publish, delete): ${this.capabilities.consequentialActions ? 'enabled' : 'disabled'}`,
      '• create requested documents and save downloads, spreadsheets, and screenshots to run artifacts',
      `• upload only attached files (${this.attachmentPaths.size}) or an exact local path written in this task`,
      '• explicit restrictions in the task still apply when a capability is enabled',
      '• record browser tabs for verification'
    ].join('\n')
  }

  private normalize(value: string): string {
    const normalized = value.replace(/\\/g, '/').trim()
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  private isReadOnly(): boolean {
    return /\bread[ -]only\b/i.test(this.task)
  }

  private deniedClause(pattern: RegExp): boolean {
    return [...this.task.matchAll(/\b(?:do not|don't|never|must not|without|avoid)\b([^.!?;\n]*)/gi)]
      .some((match) => pattern.test(match[1]))
  }

  private explicitlyDenied(
    capability: 'submitForms' | 'sensitiveInputs' | 'consequentialActions',
    element?: BrowserElement
  ): boolean {
    if (capability === 'submitForms') return this.deniedClause(/\b(?:submit\w*|forms?|log\s*in|sign\s*in)\b/i)
    if (capability === 'sensitiveInputs') return this.deniedClause(/\b(?:passwords?|credentials?|sensitive|secrets?|payment details?)\b/i)
    if (this.deniedClause(/\b(?:consequential|irreversible|changes?|modify\w*|mutat\w*)\b/i)) return true
    const descriptor = `${element?.name ?? ''} ${element?.href ?? ''}`
    const operations = [
      /\b(?:buy|purchase\w*|pay\w*|place order|checkout)\b/i,
      /\b(?:delet\w*|remov\w*|eras\w*)\b/i,
      /\b(?:send\w*|messag\w*|email\w*)\b/i,
      /\b(?:publish\w*|post\w*)\b/i,
      /\b(?:book\w*|reserv\w*)\b/i,
      /\b(?:transfer\w*)\b/i,
      /\b(?:unsubscribe|create account)\b/i
    ]
    return operations.some((operation) => operation.test(descriptor) && this.deniedClause(operation))
  }

  private taskContainsExactPath(normalizedPath: string): boolean {
    const pathCharacter = /[a-z0-9._~:/-]/i
    let index = this.normalizedTask.indexOf(normalizedPath)
    while (index >= 0) {
      const before = this.normalizedTask[index - 1]
      const after = this.normalizedTask[index + normalizedPath.length]
      if ((!before || !pathCharacter.test(before)) && (!after || !pathCharacter.test(after))) {
        return true
      }
      index = this.normalizedTask.indexOf(normalizedPath, index + 1)
    }
    return false
  }
}
