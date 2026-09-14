import { useEffect, useRef, useState } from 'react'
import type { Artifact, Attachment, ProviderSettings, RunEvent } from './types'
import { cleanup, execute, observe } from './browser'
import { createArtifact, downloadArtifact, readAttachments } from './documents'
import { runAgent } from './runner'
import { validateSettings } from './provider'
import { emptySettings, forgetKey, loadSettings, normalizeOrigins, saveSettings } from './settings'

type View = 'work' | 'files' | 'settings'
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`

export default function App() {
  const [view, setView] = useState<View>('work')
  const [settings, setSettings] = useState<ProviderSettings>(emptySettings)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState<{ id: number; title: string; origin: string }>()
  const [origins, setOrigins] = useState('')
  const [task, setTask] = useState('')
  const [maxSteps, setMaxSteps] = useState(25)
  const [allowSubmit, setAllowSubmit] = useState(false)
  const [allowSensitive, setAllowSensitive] = useState(false)
  const [approved, setApproved] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [result, setResult] = useState('')
  const controller = useRef<AbortController>()
  const runningRef = useRef(false)
  const activeTabId = useRef<number>()
  const attachmentBusy = useRef(false)
  const attachmentList = useRef<Attachment[]>([])
  const artifactList = useRef<Artifact[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  const message = (value: unknown) => {
    let text = value instanceof Error ? value.message : 'Something went wrong. Please try again.'
    if (settings.apiKey) text = text.split(settings.apiKey).join('[redacted]')
    return text.slice(0, 500)
  }
  const refreshTab = async () => {
    try {
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!current?.id || !current.url || !/^https?:\/\//.test(current.url)) {
        setTab(undefined)
        setNotice('Open a regular website, then click the Aster toolbar icon. Chrome settings and store pages cannot be controlled.')
        return
      }
      const origin = new URL(current.url).origin
      setTab({ id: current.id, title: current.title || origin, origin })
      setOrigins(origin)
      setNotice('')
      setApproved(false)
    } catch { setNotice('Click the Aster toolbar icon on the website you want to use, then refresh the selected tab.') }
  }
  useEffect(() => {
    void loadSettings().then((value) => { setSettings(value); setSaved(Boolean(value.apiKey && value.model)); if (!value.apiKey || !value.model) setView('settings') })
      .catch(() => setError('Could not load settings. Close and reopen the panel.')).finally(() => setLoaded(true))
    void refreshTab()
    const stop = () => { controller.current?.abort(); if (activeTabId.current) void cleanup(activeTabId.current).catch(() => {}) }
    const changedTab = (info: { tabId: number; windowId: number }) => {
      if (activeTabId.current !== undefined && info.tabId !== activeTabId.current) stop()
    }
    const removedTab = (id: number) => { if (id === activeTabId.current) stop() }
    const credentialChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.credential) {
        stop()
        void loadSettings().then((value) => { setSettings(value); setSaved(Boolean(value.apiKey && value.model)); setApproved(false) }).catch(() => setSaved(false))
      }
    }
    window.addEventListener('pagehide', stop)
    chrome.tabs.onActivated.addListener(changedTab)
    chrome.tabs.onRemoved.addListener(removedTab)
    chrome.storage.onChanged.addListener(credentialChanged)
    return () => { stop(); window.removeEventListener('pagehide', stop); chrome.tabs.onActivated.removeListener(changedTab); chrome.tabs.onRemoved.removeListener(removedTab); chrome.storage.onChanged.removeListener(credentialChanged) }
  }, [])
  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [events.length])

  const stop = () => { controller.current?.abort(); setNotice('Stopping… No new actions will be started. An already-sent click cannot be undone.') }
  const start = async (event: React.FormEvent) => {
    event.preventDefault()
    if (runningRef.current || attachmentBusy.current) return
    setError(''); setNotice('')
    try {
      if (!tab) throw new Error('Select a regular website first.')
      if (!approved) throw new Error('Review and approve this task before starting.')
      if (task.trim().length < 3 || task.length > 12000) throw new Error('Enter a task between 3 and 12,000 characters.')
      const selected = validateSettings(settings)
      const allowed = normalizeOrigins(origins)
      if (!allowed.includes(tab.origin)) throw new Error('The selected tab’s origin must be included in allowed websites.')
      if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 75) throw new Error('Choose a step limit from 1 to 75.')
      // Request optional website permissions directly in the user gesture, before any await.
      const permission = chrome.permissions.request({ origins: allowed.map((origin) => `${origin}/*`) })
      runningRef.current = true
      setRunning(true)
      setEvents([]); setResult('')
      controller.current = new AbortController()
      const signal = controller.current.signal
      if (!await permission) throw new Error('Website access was not granted. No task was started.')
      signal.throwIfAborted()
      await navigator.locks.request('aster-agent-run', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('Aster is already working in another panel. Stop that task first.')
        signal.throwIfAborted()
        activeTabId.current = tab.id
        setEvents([]); setResult(''); setView('work')
        try {
        const outcome = await runAgent({ task: task.trim(), settings: selected, maxSteps, signal,
          scope: { tabId: tab.id, origins: allowed, allowSubmit, allowSensitive, attachments: attachmentList.current },
          onEvent: (item) => setEvents((items) => [...items.slice(-149), item]),
          onArtifact: (item) => { artifactList.current = [...artifactList.current, item]; setArtifacts(artifactList.current) }
        }, { observe, execute, createArtifact: async (action) => {
          const item = await createArtifact(action)
          if (artifactList.current.length >= 30 || artifactList.current.reduce((sum, file) => sum + file.size, 0) + item.size > 100 * 1024 * 1024) throw new Error('File library is full. Download and clear files before another task.')
          return item
        } })
        setResult(outcome.summary)
        } finally {
          // Keep ownership until cleanup finishes; an old run must not clear the next run's refs.
          await cleanup(tab.id).catch(() => {})
          activeTabId.current = undefined
        }
      })
    } catch (value) {
      if (controller.current?.signal.aborted) setResult('Task stopped. Review the page before starting again.')
      else setError(message(value))
    } finally {
      if (activeTabId.current) await cleanup(activeTabId.current).catch(() => {})
      activeTabId.current = undefined
      controller.current = undefined
      runningRef.current = false
      setRunning(false); setApproved(false); setNotice('')
    }
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setNotice('')
    try { const value = validateSettings(settings); await saveSettings(value); setSettings(value); setSaved(true); setView('work'); setNotice('Model settings saved. Your key stays in memory for this browser session.') }
    catch (value) { setError(message(value)) }
  }
  const attach = async (files: FileList | null) => {
    if (!files || attachmentBusy.current || runningRef.current) return
    attachmentBusy.current = true; setAttaching(true); setApproved(false)
    setError('')
    try {
      const next = await readAttachments(Array.from(files))
      if (attachmentList.current.length + next.length > 10 || [...attachmentList.current, ...next].reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error('Limit attachments to 10 files and 20 MB total.')
      attachmentList.current = [...attachmentList.current, ...next]
      setAttachments(attachmentList.current); setApproved(false)
    } catch (value) { setError(message(value)) }
    finally { attachmentBusy.current = false; setAttaching(false) }
  }
  if (!loaded) return <main className="loading">Opening Aster…</main>

  return <div className="app">
    <header className="app-header"><div className="brand"><img src="icons/aster.png" width="36" height="36" alt="" /><div><h1>Aster<span className="badge">BETA</span></h1><p>Your browser, with an agent.</p></div></div><span className={`status ${running ? 'live' : ''}`}><i />{running ? 'Working' : 'Ready'}</span></header>
    <nav aria-label="Aster views">{(['work', 'files', 'settings'] as View[]).map((item) => <button key={item} aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>{item === 'work' ? 'Workspace' : item === 'files' ? `Files${artifacts.length ? ` (${artifacts.length})` : ''}` : 'Settings'}</button>)}</nav>
    <main>
      {error && <div className="banner error" role="alert">{error}<button className="dismiss" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {notice && <p className="banner" role="status">{notice}</p>}
      {view === 'settings' && <section>
        <div className="section-intro"><span className="eyebrow">BRING YOUR OWN MODEL</span><h2>Connect your AI</h2><p>No Aster account or backend. Requests go directly to your selected provider.</p></div>
        <form onSubmit={save} className="stack">
          <label>Provider<select disabled={running} value={settings.provider} onChange={(event) => { setSettings({ provider: event.target.value as ProviderSettings['provider'], apiKey: '', model: '' }); setSaved(false) }}><option value="openrouter">OpenRouter</option><option value="groq">Groq</option></select></label>
          <label>Model ID<input disabled={running} required autoComplete="off" placeholder={settings.provider === 'openrouter' ? 'Paste an exact OpenRouter model ID' : 'Paste an exact Groq model ID'} value={settings.model} maxLength={200} onChange={(event) => { setSettings({ ...settings, model: event.target.value }); setSaved(false) }} /></label>
          <p className="hint">Use a text/chat model available to your account. Model quality affects task reliability. Your provider may charge for requests.</p>
          <label>API key<input disabled={running} type="password" required autoComplete="off" spellCheck={false} placeholder="Paste your API key" value={settings.apiKey} maxLength={512} onChange={(event) => { setSettings({ ...settings, apiKey: event.target.value }); setSaved(false) }} /></label>
          <p className="hint">Session-only: the key is cleared when Chrome restarts or the extension reloads. It is not synced or written to a project file.</p>
          <button className="primary" disabled={running} type="submit">Save and open workspace</button>
          <button disabled={running || !settings.apiKey} type="button" className="secondary" onClick={() => { void forgetKey().then(() => { setSettings({ ...settings, apiKey: '' }); setSaved(false); setNotice('API key removed from this browser session.') }).catch(() => setError('Could not remove the key. Try again.')) }}>Forget API key</button>
        </form>
        <aside className="info-card"><h3>Your data stays under your control</h3><p>A task sends its prompt, approved page text, element labels, and supported attachment text to your AI provider. Attached binaries go to a website only through an approved upload action.</p><p>No background browsing or telemetry. Closing this panel stops the task. Download files you want to keep before closing it.</p><a href="https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/PRIVACY.md" target="_blank" rel="noreferrer">Privacy and limitations ↗</a></aside>
      </section>}
      {view === 'work' && <section>
        <div className="target-card"><span className="target-icon" aria-hidden="true">◎</span><div><span className="eyebrow">SELECTED TAB</span><strong title={tab?.title}>{tab?.title || 'Choose a website'}</strong><small>{tab?.origin || 'Open a site and click the Aster toolbar icon'}</small></div><button disabled={running} aria-label="Refresh selected tab" title="Refresh selected tab" onClick={() => { void refreshTab() }}>↻</button></div>
        {!saved && <p className="banner">Add your key and model in <button className="text-button" onClick={() => setView('settings')}>Settings</button> before starting.</p>}
        <form onSubmit={start} className="stack task-form">
          <label><span className="heading-label">What should we do?</span><textarea aria-label="What should we do?" disabled={running} required placeholder="Find the distributors listed on this page and create an Excel file with their contact details." value={task} maxLength={12000} onChange={(event) => { setTask(event.target.value); setApproved(false) }} rows={4} /></label>
          <div className="attachment-row"><label className={`attach-button ${running || attaching ? 'disabled' : ''}`}>{attaching ? 'Reading files…' : '＋ Attach files'}<input aria-label="Attach files" type="file" multiple disabled={running || attaching} onChange={(event) => { void attach(event.target.files); event.target.value = '' }} /></label><span className="hint">10 MB each · 20 MB total</span></div>
          {attachments.length > 0 && <ul className="attachments">{attachments.map((file) => <li key={file.id}><span title={file.name}>{file.name}<small>{sizeLabel(file.size)} · {file.text === undefined ? 'upload only; contents not read' : 'readable text'}</small></span><button type="button" disabled={running || attaching} aria-label={`Remove ${file.name}`} onClick={() => { attachmentList.current = attachmentList.current.filter((item) => item.id !== file.id); setAttachments(attachmentList.current); setApproved(false) }}>×</button></li>)}</ul>}
          <details className="scope" open><summary>Task access <span>Review once per task</span></summary><div className="stack">
            <label>Allowed website origins<textarea disabled={running} value={origins} placeholder="https://example.com" onChange={(event) => { setOrigins(event.target.value); setApproved(false) }} rows={2} /><small>One origin per line. Add destination websites before starting; unrelated tabs are never controlled.</small></label>
            <label className="check"><input type="checkbox" disabled={running} checked={allowSubmit} onChange={(event) => { setAllowSubmit(event.target.checked); setApproved(false) }} /><span>Allow form submissions and consequential clicks for this task<small>May send, publish, delete or purchase. Enable only when the task explicitly requires it.</small></span></label>
            <label className="check"><input type="checkbox" disabled={running} checked={allowSensitive} onChange={(event) => { setAllowSensitive(event.target.checked); setApproved(false) }} /><span>Allow entering sensitive fields for this task<small>Only when needed. Avoid including passwords or financial details in your prompt.</small></span></label>
            <label className="step-limit">Maximum steps<input type="number" min={1} max={75} disabled={running} value={maxSteps} onChange={(event) => { setMaxSteps(Number(event.target.value)); setApproved(false) }} /></label>
          </div></details>
          <label className="check approval"><input type="checkbox" disabled={running || attaching} checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>I approve this task on the websites above and sharing the needed page/attachment text with my AI provider.</span></label>
          <button className={running ? 'stop' : 'primary'} type={running ? 'button' : 'submit'} disabled={!running && (attaching || !saved || !tab || !approved || !task.trim())} onClick={running ? stop : undefined}>{running ? '■ Stop task' : 'Start task →'}</button>
          <p className="hint centered">Keep this panel and the selected tab open. Switching tabs stops further actions.</p>
        </form>
        {(events.length > 0 || result) && <section className="activity"><div className="activity-heading"><h2>Activity</h2><span>{events.filter((item) => item.kind === 'action').length} actions</span></div><ol aria-label="Task activity">{events.map((item) => <li key={item.id} className={item.kind}><span className="event-dot" /><div><p>{item.message}</p><time>{new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{item.step ? ` · Step ${item.step}` : ''}</time></div></li>)}</ol>{result && <div className="result" role="status"><h3>Task result</h3><p>{result}</p>{artifacts.length > 0 && <button className="secondary" onClick={() => setView('files')}>View downloadable files →</button>}</div>}<div ref={scrollRef} /></section>}
      </section>}
      {view === 'files' && <section><div className="section-intro"><span className="eyebrow">YOUR DELIVERABLES</span><h2>Ready to download</h2><p>Real files, created locally. Save them before closing the panel. PDF supports Latin text; choose Word for Telugu and other scripts.</p></div>{artifacts.length === 0 ? <div className="empty"><span aria-hidden="true">↧</span><h3>No files yet</h3><p>Ask Aster for an Excel sheet, PDF, Word document, or text file.</p><button className="secondary" onClick={() => setView('work')}>Back to workspace</button></div> : <ul className="file-list">{artifacts.map((file) => <li key={file.id}><div className="file-type">{file.name.split('.').pop()?.toUpperCase()}</div><div><strong>{file.name}</strong><small>{sizeLabel(file.size)}</small><button onClick={() => { void downloadArtifact(file).catch((value) => setError(message(value))) }}>Download ↓</button></div></li>)}</ul>}{artifacts.length > 0 && <button className="secondary" disabled={running} onClick={() => { artifactList.current = []; setArtifacts([]) }}>Clear this file list</button>}</section>}
    </main><footer>ASTER <span>Local extension · v0.1.0 beta</span></footer>
  </div>
}
