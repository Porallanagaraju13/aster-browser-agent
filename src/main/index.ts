import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
import { AgentRunner } from './agent-runner'
import { SettingsStore } from './settings'
import { resolveArtifactFile } from './artifact-access'
import { validateUploadFiles } from './upload-files'
import { listDownloadArtifacts } from './download-library'
import { renderPdf } from './pdf-renderer'
import { CredentialStore, type StoredProviderCredential } from './credential-store'
import {
  credentialStatus,
  environmentCredential,
  normalizeProvider,
  PROVIDER_DEFAULT_MODELS,
  validateProviderCredential
} from './provider-config'
import type {
  AppSettings,
  ArtifactCommandResult,
  FileSelectionResult,
  ProviderCredentialInput,
  ProviderCredentialResult,
  ProviderCredentialStatus,
  StartRunInput
} from '../shared/types'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let runner: AgentRunner | null = null
let settingsStore: SettingsStore | null = null
let credentialStore: CredentialStore | null = null

async function configuredCredential(): Promise<{
  credential?: StoredProviderCredential
  source: ProviderCredentialStatus['source']
}> {
  const stored = await credentialStore!.get()
  if (stored) return { credential: stored, source: 'stored' }
  const settings = await settingsStore!.get()
  const environment = environmentCredential(settings.provider, settings.model)
  return { credential: environment, source: environment ? 'environment' : 'none' }
}

async function providerCredentialStatus(): Promise<ProviderCredentialStatus> {
  const { credential, source } = await configuredCredential()
  return credentialStatus(credential, source, credentialStore!.isEncryptionAvailable())
}

function createWindow(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.resolve('build/icon.png')
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#08090b',
    icon: iconPath,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    ...(isMac ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      safeDialogs: true,
      spellcheck: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(path.join(currentDir, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock()
if (!ownsSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function installIpcHandlers(): void {
  ipcMain.handle('uploads:select', async (): Promise<FileSelectionResult> => {
    try {
      const options: Electron.OpenDialogOptions = {
        title: 'Attach files for this browser task',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'All file types', extensions: ['*'] }]
      }
      const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      if (selection.canceled) return { ok: false, canceled: true }
      const paths = await validateUploadFiles(selection.filePaths)
      const files = await Promise.all(paths.map(async (file) => ({ path: file, name: path.basename(file), size: (await stat(file)).size })))
      return { ok: true, files }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('artifacts:list-downloads', async () => listDownloadArtifacts(runner!.getArtifactsRoot()))
  ipcMain.handle('settings:get', async () => settingsStore!.get())
  ipcMain.handle('settings:save', async (_event, settings: AppSettings) => settingsStore!.save(settings))
  ipcMain.handle('credentials:get', async () => providerCredentialStatus())
  ipcMain.handle(
    'credentials:save',
    async (_event, input: ProviderCredentialInput): Promise<ProviderCredentialResult> => {
      try {
        const provider = normalizeProvider(input?.provider)
        const model = String(input?.model ?? '').trim().slice(0, 160) || PROVIDER_DEFAULT_MODELS[provider]
        const replacementKey = String(input?.apiKey ?? '').trim()
        const current = await configuredCredential().catch((error) => {
          if (replacementKey) return { credential: undefined, source: 'none' as const }
          throw error
        })
        const apiKey = replacementKey || (
          current.credential?.provider === provider ? current.credential.apiKey : ''
        )
        if (!apiKey) {
          return { ok: false, error: `Paste a ${provider} API key when switching providers.` }
        }
        const capabilities = await validateProviderCredential({ provider, model, apiKey })
        await credentialStore!.save({ provider, model, apiKey, supportsImages: capabilities.supportsImages })
        const settings = await settingsStore!.get()
        await settingsStore!.save({ ...settings, provider, model })
        return { ok: true, status: await providerCredentialStatus() }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  ipcMain.handle('credentials:remove', async (): Promise<ProviderCredentialResult> => {
    try {
      await credentialStore!.remove()
      return { ok: true, status: await providerCredentialStatus() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('agent:start', async (_event, input: StartRunInput) => {
    try {
      const { credential } = await configuredCredential()
      if (!credential) {
        return { ok: false, error: 'Connect an API provider, key, and model before running a task.' }
      }
      if (credential.provider !== normalizeProvider(input?.provider) || credential.model !== String(input?.model ?? '').trim()) {
        return { ok: false, error: 'Save and validate the selected provider and model before running.' }
      }
      return runner!.start({ ...input, ...credential })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('agent:stop', async () => runner!.stop())
  ipcMain.handle(
    'agent:resolve-approval',
    (_event, id: string, approved: boolean, remember: boolean) => {
      runner!.resolveApproval(id, approved, remember)
    }
  )
  ipcMain.handle('artifacts:open', async () => {
    const root = runner!.getArtifactsRoot()
    await mkdir(root, { recursive: true })
    await shell.openPath(root)
  })
  ipcMain.handle('artifacts:open-file', async (_event, requestedPath: string): Promise<ArtifactCommandResult> => {
    try {
      const artifactPath = await resolveArtifactFile(
        runner!.getArtifactsRoot(),
        String(requestedPath ?? '')
      )
      const error = await shell.openPath(artifactPath)
      return error ? { ok: false, error } : { ok: true, path: artifactPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('artifacts:save-as', async (_event, requestedPath: string): Promise<ArtifactCommandResult> => {
    try {
      const artifactPath = await resolveArtifactFile(
        runner!.getArtifactsRoot(),
        String(requestedPath ?? '')
      )
      const options = {
        title: 'Save Aster artifact',
        defaultPath: path.basename(artifactPath)
      }
      const selection = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (selection.canceled || !selection.filePath) return { ok: false, canceled: true }
      await copyFile(artifactPath, selection.filePath)
      return { ok: true, path: selection.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

app.whenReady().then(async () => {
  app.setAppUserModelId('dev.local.aster-browser-agent')
  Menu.setApplicationMenu(null)
  const userData = app.getPath('userData')
  const artifactsRoot = path.join(userData, 'artifacts')
  const profileDir = path.join(userData, 'isolated-browser-profile')
  settingsStore = new SettingsStore(path.join(userData, 'settings.json'))
  credentialStore = new CredentialStore(path.join(userData, 'credentials.json'), safeStorage)
  runner = new AgentRunner({
    artifactsRoot,
    profileDir,
    renderPdf,
    emitEvent: (event) => mainWindow?.webContents.send('agent:event', event),
    emitApproval: (request) => mainWindow?.webContents.send('agent:approval', request),
    emitLiveFrame: (frame) => mainWindow?.webContents.send('browser:frame', frame)
  })

  installIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitAfterCleanup = false
app.on('before-quit', (event) => {
  if (quitAfterCleanup || !runner) return
  event.preventDefault()
  void runner.stop().finally(() => {
    quitAfterCleanup = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
