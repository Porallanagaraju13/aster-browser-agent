import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'

/** Chromium shapes Unicode text (including Indic scripts) without opening a visible window. */
export async function renderPdf(html: string): Promise<Uint8Array> {
  const isolatedSession = session.fromPartition(`aster-pdf-${randomUUID()}`, { cache: false })
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('data:') && details.url !== 'about:blank' })
  })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolatedSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      backgroundThrottling: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const timeout = setTimeout(() => {
    if (!window.isDestroyed()) window.destroy()
  }, 30_000)
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await window.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      preferCSSPageSize: true,
      generateTaggedPDF: true
    })
  } finally {
    clearTimeout(timeout)
    if (!window.isDestroyed()) window.destroy()
    await isolatedSession.clearStorageData().catch(() => undefined)
  }
}
