export type RunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'stopping'
  | 'incomplete'
  | 'completed'
  | 'failed'
  | 'stopped'

export type ModelProvider = 'google' | 'openrouter' | 'groq' | 'nvidia'

export type AgentEventType =
  | 'status'
  | 'thought'
  | 'action'
  | 'observation'
  | 'artifact'
  | 'approval_requested'
  | 'approval_resolved'
  | 'error'
  | 'complete'

export interface AgentEvent {
  id: string
  runId: string
  type: AgentEventType
  timestamp: string
  title: string
  detail?: string
  status?: RunStatus
  step?: number
  screenshotDataUrl?: string
  artifactPath?: string
  metadata?: Record<string, unknown>
}

export interface ApprovalRequest {
  id: string
  runId: string
  title: string
  reason: string
  risk: 'medium' | 'high'
  action: string
  preview: string
  rememberable: boolean
}

export interface StartRunInput {
  task: string
  apiKey?: string
  provider: ModelProvider
  model: string
  maxSteps: number
  allowlist: string[]
  attachments?: string[]
  capabilities?: Partial<TaskCapabilities>
  supportsImages?: boolean
}

export interface TaskCapabilities {
  unrestrictedNavigation: boolean
  submitForms: boolean
  sensitiveInputs: boolean
  consequentialActions: boolean
}

export interface AttachedFile {
  path: string
  name: string
  size: number
}

export interface FileSelectionResult {
  ok: boolean
  canceled?: boolean
  files?: AttachedFile[]
  error?: string
}

export interface DownloadArtifact {
  path: string
  name: string
  runId: string
  size: number
  createdAt: string
}

export interface StartRunResult {
  ok: boolean
  runId?: string
  error?: string
}

export interface AppSettings {
  provider: ModelProvider
  model: string
  maxSteps: number
  allowlist: string[]
}

export interface ProviderCredentialInput {
  provider: ModelProvider
  model: string
  apiKey?: string
}

export interface ProviderCredentialStatus {
  configured: boolean
  provider: ModelProvider
  model: string
  source: 'stored' | 'environment' | 'none'
  encryptionAvailable: boolean
  supportsImages?: boolean
}

export interface ProviderCredentialResult {
  ok: boolean
  status?: ProviderCredentialStatus
  error?: string
}

export interface BrowserElement {
  ref: string
  tag: string
  role: string
  name: string
  type?: string
  href?: string
  disabled: boolean
  sensitive: boolean
  checked?: boolean
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
}

export interface PageObservation {
  url: string
  title: string
  text: string
  elements: BrowserElement[]
  screenshotDataUrl: string
  screenshotPath: string
  tabs: BrowserTab[]
  activeTabId: string
}

export interface LiveBrowserFrame {
  dataUrl: string
  url: string
  title: string
  timestamp: string
  sequence: number
}

export interface BrowserAction {
  name:
    | 'navigate'
    | 'inspect_page'
    | 'click'
    | 'type_text'
    | 'hover'
    | 'select_option'
    | 'check'
    | 'scroll'
    | 'press_key'
    | 'go_back'
    | 'go_forward'
    | 'reload'
    | 'new_tab'
    | 'list_tabs'
    | 'switch_tab'
    | 'close_tab'
    | 'download'
    | 'save_spreadsheet'
    | 'save_file'
    | 'upload_file'
    | 'screenshot'
    | 'wait'
    | 'finish'
  arguments: Record<string, unknown>
  callId: string
}

export interface ActionResult {
  ok: boolean
  message: string
  data?: Record<string, unknown>
}

export interface ArtifactCommandResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

export interface BrowserAgentApi {
  selectUploadFiles: () => Promise<FileSelectionResult>
  listDownloads: () => Promise<DownloadArtifact[]>
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  getProviderCredential: () => Promise<ProviderCredentialStatus>
  saveProviderCredential: (input: ProviderCredentialInput) => Promise<ProviderCredentialResult>
  removeProviderCredential: () => Promise<ProviderCredentialResult>
  startRun: (input: StartRunInput) => Promise<StartRunResult>
  stopRun: () => Promise<void>
  resolveApproval: (id: string, approved: boolean, remember: boolean) => Promise<void>
  openArtifactFolder: () => Promise<void>
  openArtifact: (path: string) => Promise<ArtifactCommandResult>
  saveArtifactAs: (path: string) => Promise<ArtifactCommandResult>
  onAgentEvent: (callback: (event: AgentEvent) => void) => () => void
  onApprovalRequest: (callback: (request: ApprovalRequest) => void) => () => void
  onBrowserFrame: (callback: (frame: LiveBrowserFrame) => void) => () => void
}
