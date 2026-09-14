import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ActionResult, AgentEvent, ApprovalRequest, BrowserAction, LiveBrowserFrame, PageObservation, RunStatus, StartRunInput, StartRunResult } from '../shared/types'
import { BrowserController } from './browser-controller'
import { createPlanner } from './planner'
import { environmentCredential, normalizeProvider, PROVIDER_DEFAULT_MODELS, PROVIDER_LABELS } from './provider-config'
import { isInPageActionHref, normalizeAllowlistEntry } from './safety'
import { TaskPermissionScope } from './run-permissions'
import { extractSensitiveTaskValues, redactAgentEvent, redactSensitiveText } from './redaction'
import { expectedDeliverables, verifyDeliverables } from './deliverables'
import { requestedUploadPaths, validateUploadFiles } from './upload-files'

interface AgentRunnerOptions {
  artifactsRoot: string
  profileDir: string
  emitEvent: (event: AgentEvent) => void
  emitApproval: (request: ApprovalRequest) => void
  emitLiveFrame: (frame: LiveBrowserFrame) => void
  renderPdf?: (html: string) => Promise<Uint8Array>
}

interface RunContext {
  id: string
  dir: string
  input: StartRunInput
  apiKey: string
  abort: AbortController
  browser?: BrowserController
  browserReady: boolean
  closing?: Promise<void>
  operation?: Promise<void>
  scope: TaskPermissionScope
  pending: Map<string, (approved: boolean) => void>
  sensitive: string[]
  produced: string[]
  logWrites: Promise<void>
  logError?: string
  lastActionFailed: boolean
}

/** Each run owns its state; terminal status is published only after browser cleanup. */
export class AgentRunner {
  private active?: RunContext
  constructor(private readonly options: AgentRunnerOptions) {}

  async start(input: StartRunInput): Promise<StartRunResult> {
    if (this.active) return { ok: false, error: 'Another task is running or still stopping.' }
    const task = typeof input?.task === 'string' ? input.task.trim() : ''
    if (!task) return { ok: false, error: 'Describe what the browser agent should accomplish.' }
    if (task.length > 2_000) return { ok: false, error: 'Keep the task under 2,000 characters.' }
    const provider = normalizeProvider(input.provider)
    const model = String(input.model || PROVIDER_DEFAULT_MODELS[provider]).trim().slice(0, 160)
    const environment = environmentCredential(provider, model)
    const apiKey = input.apiKey?.trim() || (environment?.provider === provider ? environment.apiKey : '')
    if (!apiKey) return { ok: false, error: `Connect a ${PROVIDER_LABELS[provider]} API key before running a task.` }
    if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.some((file) => typeof file !== 'string'))) {
      return { ok: false, error: 'Attached files must be selected with the file picker.' }
    }
    const capabilities = {
      unrestrictedNavigation: input.capabilities?.unrestrictedNavigation === true,
      submitForms: input.capabilities?.submitForms === true,
      sensitiveInputs: input.capabilities?.sensitiveInputs === true,
      consequentialActions: input.capabilities?.consequentialActions === true
    }
    const allowlist = [...new Set([
      ...(Array.isArray(input.allowlist) ? input.allowlist.filter((host): host is string => typeof host === 'string') : []),
      ...taskHosts(task)
    ].map(normalizeAllowlistEntry).filter(Boolean))].slice(0, 100)
    const sanitized: StartRunInput = {
      ...input, task, provider, model, capabilities, allowlist, attachments: [...(input.attachments ?? [])],
      maxSteps: Math.min(Math.max(Math.round(Number(input.maxSteps) || 60), 1), 200)
    }
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const context: RunContext = {
      id, dir: path.join(this.options.artifactsRoot, id), input: sanitized, apiKey,
      abort: new AbortController(), browserReady: false,
      scope: new TaskPermissionScope(task, sanitized.attachments, capabilities),
      pending: new Map(), sensitive: [...extractSensitiveTaskValues(task), apiKey],
      produced: [], logWrites: Promise.resolve(), lastActionFailed: false
    }
    // Reserve ownership before the first await, including concurrent/double-click starts.
    this.active = context
    context.operation = this.run(context)
    return { ok: true, runId: id }
  }

  async stop(): Promise<void> {
    const context = this.active
    if (!context) return
    context.abort.abort(new Error('Task stopped by user.'))
    this.setStatus(context, 'stopping', 'Stopping task', 'Canceling model work and closing this task’s browser.')
    for (const resolve of context.pending.values()) resolve(false)
    context.pending.clear()
    if (context.browserReady) await this.closeBrowser(context)
    await context.operation
  }

  resolveApproval(id: string, approved: boolean, _remember: boolean): void {
    const context = this.active
    const resolve = context?.pending.get(id)
    if (!context || !resolve || context.abort.signal.aborted) return
    context.pending.delete(id)
    resolve(approved === true)
  }

  getArtifactsRoot(): string { return this.options.artifactsRoot }

  private async run(context: RunContext): Promise<void> {
    const { input } = context
    let outcome: RunStatus = 'incomplete'
    let summary = 'The task ended without a verified result.'
    try {
      await mkdir(context.dir, { recursive: true })
      this.checkActive(context)
      input.attachments = await validateUploadFiles(input.attachments ?? [])
      context.scope = new TaskPermissionScope(input.task, input.attachments, input.capabilities)
      this.checkActive(context)
      if (!await this.requestRunApproval(context)) {
        outcome = 'stopped'
        summary = 'The task was not approved; no browser actions ran.'
        return
      }
      this.checkActive(context)
      this.setStatus(context, 'starting', 'Starting isolated browser', 'Opening Chrome for the approved task. No agent action has run yet.')
      context.browser = new BrowserController({
        profileDir: this.options.profileDir, artifactDir: context.dir, allowlist: input.allowlist,
        renderPdf: this.options.renderPdf,
        onNotice: (title, detail) => this.emit(context, 'error', title, detail)
      })
      // Startup must settle before ownership can be released, even when Stop was clicked.
      await context.browser.start()
      context.browserReady = true
      this.checkActive(context)
      if (input.capabilities?.unrestrictedNavigation) context.browser.enableTaskWideNavigation()
      const planner = createPlanner({
        apiKey: context.apiKey, model: input.model, provider: input.provider,
        supportsImages: input.supportsImages, signal: context.abort.signal,
        onProgress: (message) => {
          if (this.active === context && !context.abort.signal.aborted) this.setStatus(context, 'running', 'Model request', message)
        }
      })
      this.setStatus(context, 'running', 'Browser ready', `The isolated browser is open. The next step requests a browser action from ${PROVIDER_LABELS[input.provider]}; a successful model response has not been verified yet.`)
      let observation = await this.captureObservation(context, 0)
      const planTask = `${input.task}\n\nAPPROVED RUN LIMITS:\n${context.scope.approvalPreview()}\nAllowed sites: ${input.capabilities?.unrestrictedNavigation ? 'HTTP(S) web navigation allowed for this task' : input.allowlist.join(', ')}\nAttached files available for website upload (paths, not document contents):\n${(input.attachments ?? []).map((file) => JSON.stringify(file)).join('\n') || '(none)'}\nCreate requested files with save_file/save_spreadsheet or download; finish with outcome=incomplete if blocked or a requested format is unsupported.`
      this.setStatus(context, 'running', 'Waiting for first AI action', `Provider: ${PROVIDER_LABELS[input.provider]} · Model: ${input.model}. The browser stays on its current page until the model returns an approved action. Check Activity for a response or error; Stop remains available.`)
      let turn = await abortable(planner.begin(planTask, observation), context.abort.signal)
      this.checkActive(context)
      this.setStatus(context, 'running', 'Model response received', 'Validating the requested browser action against this task’s approved limits.')
      const expectation = expectedDeliverables(input.task)
      for (let step = 1; step <= input.maxSteps; step += 1) {
        this.checkActive(context)
        if (turn.message) this.emit(context, 'thought', 'Agent update', turn.message, { step })
        if (!turn.actions.length) {
          summary = `The model returned no browser action, so task completion was not verified.${turn.message ? ` Model message: ${turn.message}` : ' Check the selected model’s tool/function support or try a more specific task.'}`
          break
        }
        const outputs: Array<{ action: BrowserAction; result: ActionResult }> = []
        let finished = false
        for (const action of turn.actions) {
          this.checkActive(context)
          this.emit(context, 'action', this.actionTitle(action), this.actionDetail(action), { step, metadata: { action: action.name } })
          if (action.name === 'finish') {
            summary = String(action.arguments.summary ?? '').trim()
            const missing = await verifyDeliverables(context.dir, expectation, context.produced, action.arguments.artifactPaths)
            this.checkActive(context)
            if (action.arguments.outcome === 'incomplete') summary = summary || 'The model could not complete this task.'
            else if (!summary || context.lastActionFailed || missing) {
              summary = missing || (context.lastActionFailed ? 'The last browser action failed; completion was not verified.' : 'The model did not supply a completion summary.')
            } else outcome = 'completed'
            finished = true
            break
          }
          const allowed = await this.authorize(context, action)
          this.checkActive(context)
          const result = allowed ? await context.browser.execute(action)
            : { ok: false, message: 'Action denied by the approved task limits. Do not retry or bypass this restriction.' }
          this.checkActive(context)
          context.lastActionFailed = !result.ok
          outputs.push({ action, result })
          if (result.ok && typeof result.data?.path === 'string') {
            const deliverable = ['save_file', 'save_spreadsheet', 'download'].includes(action.name)
            if (deliverable) context.produced.push(result.data.path)
            this.emit(context, 'artifact', deliverable ? 'Downloadable file' : 'Browser artifact', result.message, {
              step, artifactPath: result.data.path, metadata: { action: action.name, downloadable: deliverable }
            })
          }
          this.emit(context, result.ok ? 'observation' : 'error', result.ok ? 'Action completed' : 'Action failed', result.message, { step })
          if (!allowed) {
            summary = 'An action was outside the approved limits. Adjust the limits and start a new task if intended.'
            finished = true
            break
          }
        }
        if (finished) break
        observation = await this.captureObservation(context, step)
        if (step === input.maxSteps) {
          summary = `Stopped at the ${input.maxSteps}-step limit before the task was completed.`
          break
        }
        this.setStatus(context, 'running', 'Waiting for next AI action', `${PROVIDER_LABELS[input.provider]} is planning from the latest page observation. No new browser action will run until a response is received.`)
        turn = await abortable(planner.continue(turn.responseId, outputs, observation), context.abort.signal)
        this.checkActive(context)
        this.setStatus(context, 'running', 'Model response received', 'Validating the next browser action against this task’s approved limits.')
      }
    } catch (error) {
      outcome = context.abort.signal.aborted ? 'stopped' : 'failed'
      summary = context.abort.signal.aborted ? 'Task stopped by user.' : errorMessage(error)
    } finally {
      try { await this.closeBrowser(context) } catch (error) {
        outcome = 'failed'
        summary = `Browser cleanup failed: ${errorMessage(error)}`
      }
      if (context.abort.signal.aborted) { outcome = 'stopped'; summary = 'Task stopped by user.' }
      for (const resolve of context.pending.values()) resolve(false)
      context.pending.clear()
      try {
        const safeTask = redactSensitiveText(input.task, context.sensitive)
        const safeSummary = redactSensitiveText(summary, context.sensitive)
        await writeFile(path.join(context.dir, 'summary.md'), `# Browser agent run\n\nProvider: ${PROVIDER_LABELS[input.provider]}\nStatus: ${outcome}\n\n## Task\n${safeTask}\n\n## Result\n${safeSummary}\n\n## Outputs\n${context.produced.map((file) => `- ${path.basename(file)}`).join('\n') || 'No downloadable outputs.'}\n`, 'utf8')
        await context.logWrites
        if (context.logError) throw new Error(context.logError)
      } catch (error) {
        if (outcome === 'completed') outcome = 'incomplete'
        summary += ` Run records could not be fully saved: ${errorMessage(error)}`
      }
      const title = outcome === 'completed' ? 'Task complete' : outcome === 'stopped' ? 'Task stopped' : outcome === 'failed' ? 'Task failed' : 'Task incomplete'
      // Browser and summary cleanup have finished; a new task may safely start now.
      if (this.active === context) this.active = undefined
      this.setStatus(context, outcome, title, summary)
      if (outcome === 'completed') this.emit(context, 'complete', title, summary)
      await context.logWrites
    }
  }

  private async closeBrowser(context: RunContext): Promise<void> {
    if (!context.browser) return
    if (!context.closing) context.closing = (async () => {
      const videos = await context.browser!.close()
      for (const videoPath of videos) this.emit(context, 'artifact', 'Browser recording', 'Recorded browser activity.', {
        artifactPath: videoPath, metadata: { kind: 'video' }
      })
    })()
    await context.closing
  }

  private async authorize(context: RunContext, action: BrowserAction): Promise<boolean> {
    const browser = context.browser!
    if (action.name === 'upload_file') {
      try {
        // Re-resolve at dispatch time; a replaced symlink must not escape approved attachments.
        const paths = await validateUploadFiles(requestedUploadPaths(action.arguments))
        action.arguments = { ...action.arguments, paths }
        delete action.arguments.path
      } catch (error) {
        this.emit(context, 'error', 'Upload unavailable', errorMessage(error))
        return false
      }
    }
    const ref = String(action.arguments.ref ?? '')
    const element = ref ? await browser.describeElement(ref)
      : action.name === 'press_key' ? await browser.describeFocusedElement() : undefined
    const decision = context.scope.authorize(action, element)
    if (!decision.allowed) {
      this.emit(context, 'error', 'Action outside task limits', decision.reason, { metadata: { action: action.name } })
      return false
    }
    const url = ['navigate', 'new_tab'].includes(action.name) ? String(action.arguments.url ?? '')
      : action.name === 'click' && element?.href && !isInPageActionHref(element.href) ? element.href : ''
    if (url && !browser.navigationDecision(url).allowed) {
      this.emit(context, 'error', 'Navigation blocked', browser.navigationDecision(url).reason)
      return false
    }
    return true
  }

  private requestRunApproval(context: RunContext): Promise<boolean> {
    const id = randomUUID()
    const request: ApprovalRequest = {
      id, runId: context.id, title: 'Approve this browser task?',
      reason: 'This is the only approval for this run. Actions outside these limits will be blocked.',
      risk: 'high', action: 'approve_run', rememberable: false,
      preview: `${context.scope.approvalPreview()}\n\nSites: ${context.input.capabilities?.unrestrictedNavigation ? 'HTTP(S) sites needed for the task' : context.input.allowlist.join(', ') || '(no sites selected)'}`
    }
    return new Promise((resolve) => {
      // Register before notifying the UI so a quick approval cannot be lost.
      context.pending.set(id, (approved) => {
        if (approved && !context.abort.signal.aborted) {
          context.scope.grant()
          this.emit(context, 'approval_resolved', 'Task approved', 'The selected run limits are now enforced.')
          resolve(true)
        } else resolve(false)
      })
      this.setStatus(context, 'waiting_approval', request.title, request.reason)
      this.emit(context, 'approval_requested', request.title, request.preview, { metadata: { approvalId: id } })
      this.options.emitApproval(request)
    })
  }

  private async captureObservation(context: RunContext, step: number): Promise<PageObservation> {
    this.checkActive(context)
    const observation = await context.browser!.observe()
    this.checkActive(context)
    this.emit(context, 'artifact', `Screenshot ${step + 1}`, observation.title || observation.url || 'Blank page', {
      step, screenshotDataUrl: observation.screenshotDataUrl, artifactPath: observation.screenshotPath,
      metadata: { url: observation.url, elementCount: observation.elements.length, activeTabId: observation.activeTabId, tabCount: observation.tabs.length }
    })
    return observation
  }

  private setStatus(context: RunContext, status: RunStatus, title: string, detail?: string): void {
    this.emit(context, 'status', title, detail, { status })
  }

  private emit(context: RunContext, type: AgentEvent['type'], title: string, detail?: string, extra: Partial<AgentEvent> = {}): void {
    const event = redactAgentEvent({ id: randomUUID(), runId: context.id, type, timestamp: new Date().toISOString(), title, detail, ...extra }, context.sensitive)
    this.options.emitEvent(event)
    const persisted = { ...event, screenshotDataUrl: undefined }
    // Serialize writes to this captured run directory and handle disk errors.
    context.logWrites = context.logWrites.then(() => appendFile(path.join(context.dir, 'events.jsonl'), `${JSON.stringify(persisted)}\n`, 'utf8'))
      .catch((error) => { context.logError = errorMessage(error) })
  }

  private checkActive(context: RunContext): void {
    if (context.abort.signal.aborted || this.active !== context) throw new Error('Task stopped by user.')
  }

  private actionTitle(action: BrowserAction): string {
    return action.name.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
  }

  private actionDetail(action: BrowserAction): string {
    if (action.name === 'type_text') return `Type ${String(action.arguments.text ?? '').length} character(s) into ${String(action.arguments.ref ?? 'a field')}`
    if (action.name === 'save_file') return `Create ${String(action.arguments.format ?? 'document').toUpperCase()}: ${String(action.arguments.filename ?? 'document')}`
    if (action.name === 'save_spreadsheet') return `Create Excel: ${String(action.arguments.filename ?? 'results.xlsx')} (${Array.isArray(action.arguments.rows) ? action.arguments.rows.length : 0} rows)`
    if (action.name === 'finish') return String(action.arguments.summary ?? '')
    return JSON.stringify(action.arguments)
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function taskHosts(task: string): string[] {
  const urls = task.match(/https?:\/\/[^\s<>"']+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|in|io|dev|app)\b|\blocalhost(?::\d+)?/gi) ?? []
  return urls.map((url) => normalizeAllowlistEntry(url.replace(/[),.;!?]+$/, ''))).filter(Boolean)
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Task stopped by user.'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
