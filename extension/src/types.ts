export type Provider = 'openrouter' | 'groq'
export interface ProviderSettings { provider: Provider; model: string; apiKey: string }
export interface Attachment { id: string; name: string; type: string; size: number; base64: string; text?: string }
export interface Artifact { id: string; name: string; blob: Blob; mime: string; size: number }
export interface ElementInfo { ref: string; tag: string; role: string; name: string; type?: string; editable: boolean; disabled: boolean; sensitive: boolean; href?: string; options?: string[] }
export interface Observation { url: string; title: string; text: string; elements: ElementInfo[]; tabId: number }
export type Action =
  | { type: 'inspect' }
  | { type: 'navigate'; url: string }
  | { type: 'click'; ref: string }
  | { type: 'fill'; ref: string; text: string }
  | { type: 'select'; ref: string; value: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount: number }
  | { type: 'press'; ref: string; key: 'Enter' | 'Escape' | 'Tab' }
  | { type: 'upload'; ref: string; attachmentIds: string[] }
  | { type: 'save_file'; filename: string; format: 'txt' | 'md' | 'csv' | 'json' | 'html' | 'pdf' | 'docx'; content: string }
  | { type: 'save_spreadsheet'; filename: string; columns: string[]; rows: string[][] }
  | { type: 'finish'; summary: string; outcome: 'completed' | 'incomplete' }
export interface ActionResult { ok: boolean; message: string }
export interface TaskScope { tabId: number; origins: string[]; allowSubmit: boolean; allowSensitive: boolean; attachments: Attachment[] }
export interface RunEvent { id: string; time: string; kind: 'status' | 'action' | 'error' | 'complete'; message: string; step?: number }
export interface RunOptions { task: string; settings: ProviderSettings; scope: TaskScope; maxSteps: number; signal: AbortSignal; onEvent: (event: RunEvent) => void; onArtifact: (artifact: Artifact) => void }
export interface AgentDependencies {
  observe: (scope: TaskScope, signal: AbortSignal) => Promise<Observation>
  execute: (action: Action, scope: TaskScope, signal: AbortSignal) => Promise<ActionResult>
  createArtifact: (action: Extract<Action, { type: 'save_file' | 'save_spreadsheet' }>) => Promise<Artifact>
}
export type PageCommand = { kind: 'observe' } | { kind: 'act'; action: Action; allowSubmit: boolean; allowSensitive: boolean; attachments: Attachment[]; origins: string[] } | { kind: 'cleanup' }
export interface PageReply { ok: boolean; message: string; observation?: Omit<Observation, 'tabId'> }
