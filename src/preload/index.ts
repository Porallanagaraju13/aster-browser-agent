import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  AppSettings,
  ApprovalRequest,
  BrowserAgentApi,
  LiveBrowserFrame,
  StartRunInput,
  StartRunResult
} from '../shared/types'

const api: BrowserAgentApi = {
  selectUploadFiles: () => ipcRenderer.invoke('uploads:select'),
  listDownloads: () => ipcRenderer.invoke('artifacts:list-downloads'),
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings) as Promise<AppSettings>,
  getProviderCredential: () => ipcRenderer.invoke('credentials:get'),
  saveProviderCredential: (input) => ipcRenderer.invoke('credentials:save', input),
  removeProviderCredential: () => ipcRenderer.invoke('credentials:remove'),
  startRun: (input: StartRunInput) =>
    ipcRenderer.invoke('agent:start', input) as Promise<StartRunResult>,
  stopRun: () => ipcRenderer.invoke('agent:stop') as Promise<void>,
  resolveApproval: (id, approved, remember) =>
    ipcRenderer.invoke('agent:resolve-approval', id, approved, remember) as Promise<void>,
  openArtifactFolder: () => ipcRenderer.invoke('artifacts:open') as Promise<void>,
  openArtifact: (path) => ipcRenderer.invoke('artifacts:open-file', path),
  saveArtifactAs: (path) => ipcRenderer.invoke('artifacts:save-as', path),
  onAgentEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  onApprovalRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ApprovalRequest): void =>
      callback(payload)
    ipcRenderer.on('agent:approval', listener)
    return () => ipcRenderer.removeListener('agent:approval', listener)
  },
  onBrowserFrame: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LiveBrowserFrame): void =>
      callback(payload)
    ipcRenderer.on('browser:frame', listener)
    return () => ipcRenderer.removeListener('browser:frame', listener)
  }
}

contextBridge.exposeInMainWorld('browserAgent', api)
