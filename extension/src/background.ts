// The agent runs in the visible panel; no hidden background task or keepalive.
const configure = async () => {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
}
chrome.runtime.onInstalled.addListener(() => { void configure().catch(() => {}) })
chrome.runtime.onStartup.addListener(() => { void configure().catch(() => {}) })
void configure().catch(() => {})
