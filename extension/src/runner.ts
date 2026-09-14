import { nextAction, ProviderError, redactSecrets, validateSettings, type HistoryEntry } from './provider'
import type { Action, AgentDependencies, Observation, RunEvent, RunOptions } from './types'

export const RUN_LIMITS = { maxSteps: 75, taskCharacters: 12_000, maxDurationMs: 8 * 60_000, consecutiveErrors: 3, maxArtifacts: 10 } as const
type RunResult = { outcome: 'completed' | 'incomplete' | 'stopped'; summary: string }

const LABELS: Record<Action['type'], string> = {
  inspect: 'Inspecting the approved page', navigate: 'Opening an approved page', click: 'Clicking an element',
  fill: 'Entering text', select: 'Selecting an option', scroll: 'Scrolling the page', press: 'Pressing a key',
  upload: 'Uploading approved attachments', save_file: 'Creating a downloadable document',
  save_spreadsheet: 'Creating a downloadable spreadsheet', finish: 'Verifying the result'
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Task stopped.', 'AbortError'))
    // Always consume a late rejection, including cancellation during the dependency call itself.
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Require a real generated artifact for an explicit document/export request. */
function deliverableRequirement(task: string): { required: boolean; extensions: string[]; alternatives: boolean } {
  const formats = '(?:excel|xlsx|spreadsheet|csv|pdf|docx|json|html|txt|md)'
  const commands = [...task.matchAll(/\b(?:create|generate|provide|export|download|save|give|make|deliver|send|need|want|get|convert)\b/gi)]
  const outputs = commands.map((command, index) => {
    let clause = task.slice(command.index! + command[0].length, commands[index + 1]?.index ?? task.length)
    // Reading/uploading an input document is not itself a request to generate that format.
    if (/^\s+(?:to\s+)?(?:read|open|inspect|analyze|upload)\b/i.test(clause)) return ''
    const explicitOutput = new RegExp(`\\b(?:to|into|as|in)\\s+(?:(?:a|an|the)\\s+)?${formats}\\b`, 'i').exec(clause)
    if (explicitOutput && (command[0].toLowerCase() === 'convert' || /\b(?:from|using|of|attached|uploaded|input|source)\b/i.test(clause.slice(0, explicitOutput.index)))) {
      clause = clause.slice(explicitOutput.index)
    }
    // Any following output command is a separate clause, so source descriptions can end here.
    clause = clause.split(/\b(?:from|using|based on|based upon|according to)\b/i)[0]
    return clause.replace(new RegExp(`\\b(?:attached|uploaded|input|source|original)\\s+(?:(?:the|a|an)\\s+)?${formats}\\b`, 'gi'), '')
  })
  const outputText = outputs.join(' ')
  const extensions: string[] = []
  if (/\b(?:excel|xlsx|spreadsheet)\b/i.test(outputText)) extensions.push('xlsx')
  for (const extension of ['csv', 'pdf', 'docx', 'json', 'html', 'txt', 'md']) {
    if (new RegExp(`\\b${extension}\\b`, 'i').test(outputText)) extensions.push(extension)
  }
  const requested = /\b(?:file|document|report|sheet|spreadsheet|excel|xlsx|csv|pdf|docx|json|html|txt|md)\b/i.test(outputText)
    || /\b(?:file|document|report|spreadsheet|sheet)\b[\s\S]{0,40}\b(?:download|export|attachment)\b/i.test(task)
  const alternatives = extensions.length === 2 && new RegExp(`\\b${formats}\\s+(?:or|/)\\s+${formats}\\b`, 'i').test(outputText)
  return { required: requested, extensions, alternatives }
}

function documentFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Only known, content-free diagnostics may enter progress/history; library exceptions can contain input text.
  if (message.startsWith('PDF export currently supports Latin/Windows-1252')) return 'PDF export supports Latin/Windows-1252 text only. Use DOCX, HTML or TXT to preserve Unicode, emoji and non-Latin scripts, and explain the PDF limitation.'
  if (message.startsWith('PDF export is limited to 200 pages')) return 'PDF export is limited to 200 pages. Use DOCX or TXT for the larger document.'
  if (message.startsWith('JSON content is invalid')) return 'JSON content is invalid. Supply a complete valid JSON value.'
  if (message === 'CSV quoting is invalid.' || message === 'CSV contains an unclosed quoted field.') return message
  if (message === 'Document contains unsupported control characters.' || message === 'Document contains invalid Unicode text.') return message
  if (message === 'Each spreadsheet row must match the column count.') return message
  return 'The document could not be created. Check the requested format and content.'
}

function guardAction(action: Action, observation: Observation, options: RunOptions): string | undefined {
  if (JSON.stringify(action).includes(options.settings.apiKey.trim())) return 'The action contains a provider credential and cannot be performed.'
  if (action.type === 'navigate') {
    try { if (!options.scope.origins.includes(new URL(action.url).origin)) return 'Navigation is outside the approved origins. Finish incomplete or use an approved page.' } catch { return 'The navigation URL is invalid.' }
  }
  if ('ref' in action) {
    const element = observation.elements.find(entry => entry.ref === action.ref)
    if (!element) return 'The element reference is not in the latest observation. Inspect before trying again.'
    if (element.disabled) return 'The selected element is disabled.'
    if (element.sensitive && !options.scope.allowSensitive) return 'The selected element requires sensitive-action approval.'
    if (action.type === 'fill' && !element.editable) return 'The selected element cannot receive text. Choose an editable input, not a link or logo.'
    if (action.type === 'select' && element.tag.toLowerCase() !== 'select') return 'The selected element is not a select control.'
    if (action.type === 'press' && action.key === 'Enter' && !options.scope.allowSubmit) return 'Enter may submit a form and form submission was not approved.'
    if (action.type === 'upload' && (element.tag.toLowerCase() !== 'input' || element.type !== 'file')) return 'The selected element is not a file upload input.'
  }
  if (action.type === 'upload' && action.attachmentIds.some(id => !options.scope.attachments.some(file => file.id === id))) return 'Upload is limited to the attachments approved for this task.'
  return undefined
}

export async function runAgent(options: RunOptions, dependencies: AgentDependencies): Promise<RunResult> {
  let eventId = 0
  const emit = (kind: RunEvent['kind'], message: string, step?: number) => {
    try { options.onEvent({ id: `event-${Date.now()}-${++eventId}`, time: new Date().toISOString(), kind, message, step }) } catch { /* A disconnected view must not keep a task alive. */ }
  }
  const complete = (result: RunResult): RunResult => {
    emit(result.outcome === 'incomplete' ? 'error' : 'complete', result.outcome === 'completed' ? 'Task completed with the observed result.' : result.outcome === 'stopped' ? 'Task stopped. No further actions will be started.' : 'Task incomplete. Review the result before continuing.')
    return result
  }
  if (options.signal.aborted) return complete({ outcome: 'stopped', summary: 'Task stopped before it started.' })
  let settings
  try { settings = validateSettings(options.settings) } catch (error) {
    return complete({ outcome: 'incomplete', summary: error instanceof ProviderError ? error.message : 'Check your provider settings.' })
  }
  if (!options.task.trim() || options.task.length > RUN_LIMITS.taskCharacters) return complete({ outcome: 'incomplete', summary: 'Enter a task between 1 and 12,000 characters.' })
  if (!options.scope.origins.length || !Number.isInteger(options.scope.tabId)) return complete({ outcome: 'incomplete', summary: 'Approve a browser tab and at least one website origin first.' })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal.addEventListener('abort', cancel, { once: true })
  let expired = false
  const timer = setTimeout(() => { expired = true; controller.abort() }, RUN_LIMITS.maxDurationMs)
  const signal = controller.signal
  const maxSteps = Math.max(1, Math.min(RUN_LIMITS.maxSteps, Number.isFinite(options.maxSteps) ? Math.floor(options.maxSteps) : 20))
  const history: HistoryEntry[] = []
  const artifactExtensions: string[] = []
  const required = deliverableRequirement(options.task)
  let errors = 0
  const remember = (entry: HistoryEntry) => { history.push(entry); if (history.length > 10) history.shift() }
  const checkAbort = () => { if (signal.aborted) throw new DOMException('Task stopped.', 'AbortError') }
  try {
    emit('status', 'Task approved. Only the selected tab, websites and attachments are in scope.')
    for (let step = 1; step <= maxSteps; step++) {
      checkAbort()
      emit('status', 'Reading the approved page and planning one action', step)
      const observation = await abortable(dependencies.observe(options.scope, signal), signal)
      checkAbort()
      if (observation.tabId !== options.scope.tabId || !options.scope.origins.includes(new URL(observation.url).origin)) {
        return complete({ outcome: 'incomplete', summary: 'The tab is no longer on an approved website. Start a new task with the correct website scope.' })
      }
      const action = await abortable(nextAction({ settings, task: options.task, observation, history, attachments: options.scope.attachments, scope: options.scope, signal }), signal)
      checkAbort()
      emit('action', LABELS[action.type], step)
      const denied = guardAction(action, observation, options)
      if (denied) {
        emit('error', denied, step)
        remember({ action: action.type, result: denied })
        if (++errors >= RUN_LIMITS.consecutiveErrors) return complete({ outcome: 'incomplete', summary: 'Stopped after three consecutive unsafe or invalid actions. Try a more specific task or a more capable model.' })
        continue
      }
      if (action.type === 'finish') {
        const formatsCreated = required.alternatives ? required.extensions.some(extension => artifactExtensions.includes(extension)) : required.extensions.every(extension => artifactExtensions.includes(extension))
        if (action.outcome === 'completed' && required.required && (!artifactExtensions.length || !formatsCreated)) {
          const message = 'The requested downloadable file has not been created in the requested format. Create it with a save action or finish incomplete.'
          emit('error', message, step)
          remember({ action: 'finish', result: message })
          if (++errors >= RUN_LIMITS.consecutiveErrors) return complete({ outcome: 'incomplete', summary: 'The requested downloadable file was not produced. No completion is claimed.' })
          continue
        }
        if (action.outcome === 'completed') {
          // A successful mutation alone is not enough: the result must still be observable.
          const finalObservation = await abortable(dependencies.observe(options.scope, signal), signal)
          checkAbort()
          if (finalObservation.tabId !== options.scope.tabId || !options.scope.origins.includes(new URL(finalObservation.url).origin)) return complete({ outcome: 'incomplete', summary: 'The final page could not be verified within the approved scope.' })
        }
        return complete({ outcome: action.outcome, summary: redactSecrets(action.summary, settings.apiKey) })
      }
      if (action.type === 'save_file' || action.type === 'save_spreadsheet') {
        if (artifactExtensions.length >= RUN_LIMITS.maxArtifacts) return complete({ outcome: 'incomplete', summary: 'The task reached its limit of 10 generated files.' })
        try {
          const artifact = await abortable(dependencies.createArtifact(action), signal)
          checkAbort()
          if (artifact.size <= 0 || artifact.blob.size <= 0) throw new Error('Empty artifact')
          options.onArtifact(artifact)
          artifactExtensions.push(action.type === 'save_spreadsheet' ? 'xlsx' : action.format)
          remember({ action: action.type, result: 'A downloadable file was created and added to the file library.', evidence: observation.text.slice(0, 4000) })
          errors = 0
        } catch (error) {
          if (signal.aborted) throw error
          const failure = documentFailure(error)
          emit('error', failure, step)
          remember({ action: action.type, result: `Document creation failed. ${failure} Do not claim a file exists.` })
          if (++errors >= RUN_LIMITS.consecutiveErrors) return complete({ outcome: 'incomplete', summary: 'Stopped after three consecutive document creation failures.' })
        }
        continue
      }
      if (action.type === 'inspect') {
        remember({ action: 'inspect', result: 'Page observed. Choose a useful action or finish with accurate limitations.', evidence: observation.text.slice(0, 4000) })
        continue
      }
      try {
        const result = await abortable(dependencies.execute(action, options.scope, signal), signal)
        checkAbort()
        // Page-derived error strings can contain credentials or instructions; only retain a bounded, redacted result.
        remember({ action: action.type, result: redactSecrets(result.message, settings.apiKey).slice(0, 500), evidence: observation.text.slice(0, 4000) })
        if (!result.ok) {
          emit('error', 'The browser action could not be completed. The next step will inspect the page again.', step)
          if (++errors >= RUN_LIMITS.consecutiveErrors) return complete({ outcome: 'incomplete', summary: 'Stopped after three consecutive browser action failures. The website may need manual interaction.' })
        } else errors = 0
      } catch (error) {
        if (signal.aborted) throw error
        emit('error', 'The browser action failed. No raw webpage or credential details were logged.', step)
        remember({ action: action.type, result: 'Browser action failed. Inspect the current page before choosing a different action.' })
        if (++errors >= RUN_LIMITS.consecutiveErrors) return complete({ outcome: 'incomplete', summary: 'Stopped after three consecutive browser action failures. The website may need manual interaction.' })
      }
    }
    return complete({ outcome: 'incomplete', summary: `The task reached its ${maxSteps}-step limit. Any generated files remain available; review the partial result.` })
  } catch (error) {
    if (options.signal.aborted) return complete({ outcome: 'stopped', summary: 'Task stopped. Actions already submitted to a website cannot be undone automatically.' })
    if (expired) return complete({ outcome: 'incomplete', summary: 'The task reached its 8-minute time limit. No further actions were started.' })
    return complete({ outcome: 'incomplete', summary: error instanceof ProviderError ? error.message : 'The approved page could not be read or the task encountered an unexpected error. Check the tab and try again.' })
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', cancel)
  }
}
