import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Eye,
  ExternalLink,
  FileDown,
  FolderOpen,
  Globe2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MousePointerClick,
  Navigation,
  Paperclip,
  Play,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X
} from 'lucide-react'
import type {
  AgentEvent,
  AttachedFile,
  AppSettings,
  ApprovalRequest,
  DownloadArtifact,
  ModelProvider,
  ProviderCredentialStatus,
  RunStatus,
  TaskCapabilities
} from '../../shared/types'

const FALLBACK_SETTINGS: AppSettings = {
  provider: 'google',
  model: 'gemini-3.7-flash',
  maxSteps: 60,
  allowlist: ['localhost', '127.0.0.1']
}

const PROVIDERS: Array<{ value: ModelProvider; label: string; model: string }> = [
  { value: 'google', label: 'Google Gemini', model: 'gemini-3.7-flash' },
  { value: 'openrouter', label: 'OpenRouter', model: 'google/gemini-3-flash-preview' },
  { value: 'groq', label: 'Groq', model: 'qwen/qwen3.6-27b' },
  { value: 'nvidia', label: 'NVIDIA NIM', model: '' }
]

const EXAMPLES = [
  'Open my local app and verify the sign-up flow visually.',
  'Read the pricing page and summarize the three plans.',
  'Find the accessibility issues on this dashboard.'
]

const STATUS_LABELS: Record<RunStatus, string> = {
  idle: 'Ready',
  starting: 'Starting',
  running: 'Working',
  waiting_approval: 'Needs approval',
  paused: 'Paused',
  stopping: 'Stopping',
  incomplete: 'Incomplete',
  completed: 'Complete',
  failed: 'Failed',
  stopped: 'Stopped'
}

function EventIcon({ event }: { event: AgentEvent }) {
  if (event.type === 'artifact') return <Eye size={15} />
  if (event.type === 'action') return <MousePointerClick size={15} />
  if (event.type === 'approval_requested') return <ShieldCheck size={15} />
  if (event.type === 'complete') return <Check size={15} />
  if (event.type === 'error') return <AlertTriangle size={15} />
  if (event.type === 'thought') return <Sparkles size={15} />
  return <Activity size={15} />
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function providerLabel(provider: ModelProvider): string {
  return PROVIDERS.find((item) => item.value === provider)?.label ?? 'provider'
}

function App() {
  const [settings, setSettings] = useState<AppSettings>(FALLBACK_SETTINGS)
  const [apiKey, setApiKey] = useState('')
  const [credential, setCredential] = useState<ProviderCredentialStatus | null>(null)
  const [setupRequired, setSetupRequired] = useState(true)
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [credentialError, setCredentialError] = useState('')
  const [task, setTask] = useState('')
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [downloads, setDownloads] = useState<DownloadArtifact[]>([])
  const [showDownloads, setShowDownloads] = useState(false)
  const [capabilities, setCapabilities] = useState<TaskCapabilities>({
    unrestrictedNavigation: true,
    submitForms: false,
    sensitiveInputs: false,
    consequentialActions: false
  })
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [status, setStatus] = useState<RunStatus>('idle')
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [rememberApproval, setRememberApproval] = useState(true)
  const [latestScreenshot, setLatestScreenshot] = useState<string | null>(null)
  const [hasLiveFrame, setHasLiveFrame] = useState(false)
  const [currentUrl, setCurrentUrl] = useState('about:blank')
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const denyButtonRef = useRef<HTMLButtonElement>(null)
  const liveImageRef = useRef<HTMLImageElement>(null)
  const liveFrameSequenceRef = useRef(0)

  useEffect(() => {
    const refreshDownloads = () => {
      void window.browserAgent.listDownloads().then(setDownloads).catch(() => undefined)
    }
    refreshDownloads()
    void Promise.all([
      window.browserAgent.getSettings(),
      window.browserAgent.getProviderCredential()
    ])
      .then(([saved, status]) => {
        setSettings(status.source !== 'none'
          ? { ...saved, provider: status.provider, model: status.model }
          : saved
        )
        setCredential(status)
        setSetupRequired(!status.configured)
      })
      .catch((loadError) => {
        setSetupRequired(true)
        setCredentialError(messageFrom(loadError, 'Unable to load the provider configuration.'))
      })
      .finally(() => setLoading(false))

    const unsubscribeEvents = window.browserAgent.onAgentEvent((event) => {
      setEvents((current) => [...current, event].slice(-120))
      if (event.status) setStatus(event.status)
      if (event.screenshotDataUrl) {
        setLatestScreenshot(event.screenshotDataUrl)
        setHasLiveFrame(true)
      }
      if (typeof event.metadata?.url === 'string') setCurrentUrl(event.metadata.url)
      if (event.type === 'error' || event.status === 'failed' || event.status === 'incomplete') setError(event.detail || event.title)
      if (event.metadata?.downloadable || ['completed', 'incomplete', 'stopped', 'failed'].includes(event.status ?? '')) refreshDownloads()
      if (['completed', 'incomplete', 'stopped', 'failed'].includes(event.status ?? '')) setApproval(null)
    })
    const unsubscribeApproval = window.browserAgent.onApprovalRequest((request) => {
      setApproval(request)
      setRememberApproval(request.rememberable)
    })
    const unsubscribeFrames = window.browserAgent.onBrowserFrame((frame) => {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => {
        if (frame.sequence <= liveFrameSequenceRef.current) return
        liveFrameSequenceRef.current = frame.sequence
        setCurrentUrl(frame.url)
        setHasLiveFrame(true)
        if (liveImageRef.current) {
          liveImageRef.current.src = frame.dataUrl
        } else {
          setLatestScreenshot(frame.dataUrl)
        }
      }
      image.src = frame.dataUrl
    })

    return () => {
      unsubscribeEvents()
      unsubscribeApproval()
      unsubscribeFrames()
    }
  }, [])

  const running = ['starting', 'running', 'waiting_approval', 'paused', 'stopping'].includes(status)
  const statusTone = ['failed', 'stopped', 'incomplete'].includes(status)
    ? 'danger'
    : status === 'waiting_approval'
      ? 'warning'
      : ['completed'].includes(status)
        ? 'success'
        : running
          ? 'active'
          : 'neutral'

  const latestTitle = useMemo(() => {
    const event = [...events].reverse().find((item) => item.type !== 'artifact')
    return event?.title || 'Waiting for a task'
  }, [events])

  const latestProgress = useMemo(() => [...events].reverse().find((item) => item.type === 'status'), [events])

  const updateSettings = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  const selectProvider = (provider: ModelProvider) => {
    const suggested = PROVIDERS.find((item) => item.value === provider)?.model ?? ''
    setSettings((current) => ({ ...current, provider, model: suggested }))
    setApiKey('')
    setCredentialError('')
  }

  const saveProvider = async (closeSetup = false) => {
    if (!settings.model.trim()) {
      setCredentialError('Enter the exact model ID supplied by your provider.')
      return
    }
    const needsKey = !credential || credential.source === 'none' || credential.provider !== settings.provider
    if (needsKey && !apiKey.trim()) {
      setCredentialError(`Paste a ${providerLabel(settings.provider)} API key.`)
      return
    }

    setCredentialBusy(true)
    setCredentialError('')
    try {
      const result = await window.browserAgent.saveProviderCredential({
        provider: settings.provider,
        model: settings.model.trim(),
        apiKey: apiKey.trim() || undefined
      })
      if (!result.ok || !result.status) {
        setCredentialError(result.error || 'Unable to validate this provider configuration.')
        return
      }
      const saved = await window.browserAgent.saveSettings({
        ...settings,
        provider: result.status.provider,
        model: result.status.model
      })
      setSettings(saved)
      setCredential(result.status)
      setApiKey('')
      if (closeSetup) setSetupRequired(false)
    } catch (saveError) {
      setCredentialError(messageFrom(saveError, 'Unable to save this provider configuration.'))
    } finally {
      setCredentialBusy(false)
    }
  }

  const removeProvider = async () => {
    setCredentialBusy(true)
    setCredentialError('')
    try {
      const result = await window.browserAgent.removeProviderCredential()
      if (!result.ok || !result.status) {
        setCredentialError(result.error || 'Unable to remove the stored API key.')
        return
      }
      setCredential(result.status)
      setSetupRequired(!result.status.configured)
      if (result.status.configured) setSettings((current) => ({ ...current, provider: result.status!.provider, model: result.status!.model }))
      setApiKey('')
    } catch (removeError) {
      setCredentialError(messageFrom(removeError, 'Unable to remove the stored API key.'))
    } finally {
      setCredentialBusy(false)
    }
  }

  const start = async () => {
    if (running || attachmentBusy || credentialBusy) return
    if (!task.trim()) {
      setError('Describe what the browser agent should accomplish.')
      return
    }

    setError('')
    setEvents([])
    setLatestScreenshot(null)
    setHasLiveFrame(false)
    liveFrameSequenceRef.current = 0
    setCurrentUrl('about:blank')
    setStatus('starting')
    try {
      const saved = await window.browserAgent.saveSettings(settings)
      setSettings(saved)
      const result = await window.browserAgent.startRun({
        task: task.trim(),
        ...saved,
        attachments: attachments.map((file) => file.path),
        capabilities
      })
      if (!result.ok) {
        setError(result.error || 'Unable to start the task.')
        setStatus('failed')
      }
    } catch (startError) {
      setError(messageFrom(startError, 'Unable to start the task.'))
      setStatus('failed')
    }
  }

  const stop = async () => {
    setStatus('stopping')
    try {
      await window.browserAgent.stopRun()
      setApproval(null)
    } catch (stopError) {
      setError(messageFrom(stopError, 'Unable to stop the task cleanly.'))
    }
  }

  const attachFiles = async () => {
    setAttachmentBusy(true)
    try {
      const result = await window.browserAgent.selectUploadFiles()
      if (!result.ok) {
        if (!result.canceled) setError(result.error || 'Unable to attach these files.')
        return
      }
      const combined = [...new Map([...attachments, ...(result.files ?? [])].map((file) => [file.path, file])).values()]
      if (combined.length > 20 || combined.reduce((total, file) => total + file.size, 0) > 500 * 1024 * 1024) {
        setError('Attach up to 20 files, with a combined size of 500 MB.')
        return
      }
      setAttachments(combined)
    } catch (attachmentError) {
      setError(messageFrom(attachmentError, 'Unable to attach files.'))
    } finally { setAttachmentBusy(false) }
  }

  const decide = async (approved: boolean) => {
    if (!approval) return
    try {
      await window.browserAgent.resolveApproval(
        approval.id,
        approved,
        approved && rememberApproval && approval.rememberable
      )
      setApproval(null)
    } catch (approvalError) {
      setError(messageFrom(approvalError, 'Unable to apply the approval decision.'))
    }
  }

  const openArtifacts = async () => {
    try {
      await window.browserAgent.openArtifactFolder()
    } catch (artifactError) {
      setError(messageFrom(artifactError, 'Unable to open the artifacts folder.'))
    }
  }

  const openArtifact = async (artifactPath: string) => {
    try {
      const result = await window.browserAgent.openArtifact(artifactPath)
      if (!result.ok) setError(result.error || 'Unable to open this artifact.')
    } catch (artifactError) {
      setError(messageFrom(artifactError, 'Unable to open this artifact.'))
    }
  }

  const saveArtifactAs = async (artifactPath: string) => {
    try {
      const result = await window.browserAgent.saveArtifactAs(artifactPath)
      if (!result.ok && !result.canceled) setError(result.error || 'Unable to save this artifact.')
    } catch (artifactError) {
      setError(messageFrom(artifactError, 'Unable to save this artifact.'))
    }
  }

  useEffect(() => {
    if (approval) denyButtonRef.current?.focus()
  }, [approval])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (approval) {
        event.preventDefault()
        void decide(false)
      } else if (settingsOpen) {
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [approval, settingsOpen])

  if (loading) {
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" size={26} />
        <span>Preparing Aster</span>
      </div>
    )
  }

  if (setupRequired) {
    return (
      <main className="onboarding-screen">
        <section className="onboarding-card" aria-labelledby="provider-setup-title">
          <div className="onboarding-brand">
            <div className="brand-mark"><img src="./app-icon.png" alt="" /></div>
            <div><strong>Aster</strong><span>Browser Agent</span></div>
          </div>
          <span className="section-label"><KeyRound size={14} /> First-run connection</span>
          <h1 id="provider-setup-title">Connect your AI provider</h1>
          <p>Your key is encrypted with the operating system and is never included in browser artifacts. Validation checks provider/model metadata; the first approved task tests actual inference and account access.</p>

          <div className="provider-form">
            <label>
              <span>Provider</span>
              <select
                value={settings.provider}
                disabled={credentialBusy}
                onChange={(event) => selectProvider(event.target.value as ModelProvider)}
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.value} value={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>API key</span>
              <input
                type="password"
                disabled={credentialBusy}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={`Paste your ${providerLabel(settings.provider)} API key`}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>Model ID</span>
              <input
                value={settings.model}
                disabled={credentialBusy}
                onChange={(event) => updateSettings('model', event.target.value)}
                maxLength={160}
                spellCheck={false}
                placeholder={`Paste an exact ${providerLabel(settings.provider)} model ID`}
              />
              <small>Tool calling is required. Text-only models use page text and controls; compatible vision models can also see screenshots.</small>
            </label>
          </div>

          {credentialError && <div className="setup-error" role="alert"><AlertTriangle size={15} /> {credentialError}</div>}
          <button
            className="connect-button"
            onClick={() => void saveProvider(true)}
            disabled={credentialBusy}
          >
            {credentialBusy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
            {credentialBusy ? 'Validating…' : 'Validate and continue'}
          </button>
          {settings.provider === 'nvidia' && <small className="provider-note">Use a hosted NVIDIA API Catalog key and the exact tool-capable model ID from build.nvidia.com. Its public model catalog cannot verify your key; the first task checks access. No NVIDIA GPU is needed on your computer.</small>}
          <small className="provider-note">Supported directly: Google Gemini, OpenRouter, Groq, and NVIDIA NIM.</small>
        </section>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><img src="./app-icon.png" alt="" /></div>
          <div>
            <strong>Aster</strong>
            <span>Browser Agent</span>
          </div>
          <span className="build-badge">Desktop</span>
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={() => void openArtifacts()}>
            <FolderOpen size={16} /> Artifacts
          </button>
          <button
            className={`icon-button ${settingsOpen ? 'selected' : ''}`}
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Toggle settings"
            aria-expanded={settingsOpen}
            aria-controls="run-settings"
          >
            <Settings2 size={17} />
          </button>
          <div className={`status-pill ${statusTone}`} role="status" aria-live="polite">
            <span className="status-dot" />
            {STATUS_LABELS[status]}
          </div>
        </div>
      </header>

      <main className="workspace">
        <aside className="mission-panel">
          <div className="section-label"><Bot size={14} /> Mission</div>
          <h1>What should I do in the browser?</h1>
          <p className="muted">Give one clear outcome. Aster will plan, act, verify, and leave a visual trail.</p>

          <div className="task-composer">
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="e.g. Open localhost:3000, test checkout, and report any broken states…"
              aria-label="Browser task"
              maxLength={2_000}
              disabled={running}
            />
            <div className="composer-footer">
              <span>{task.length}/2,000</span>
              {running ? (
                <button className="stop-button" onClick={() => void stop()} disabled={status === 'stopping'}>
                  <CircleStop size={16} /> {status === 'stopping' ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <button className="run-button" onClick={() => void start()} disabled={attachmentBusy || credentialBusy}>
                  <Play size={15} fill="currentColor" /> Run agent
                </button>
              )}
            </div>
          </div>

          <section className="attachments" aria-label="Task attachments">
            <button className="attach-button" onClick={() => void attachFiles()} disabled={running || attachmentBusy}>
              <Paperclip size={14} /> {attachmentBusy ? 'Selecting…' : 'Attach files'}
            </button>
            <small>Any file type for website upload. Up to 20 files, 100 MB each; the website may limit accepted types.</small>
            {attachments.map((file) => (
              <div className="attached-file" key={file.path} title={file.path}>
                <span>{file.name}<small>{formatBytes(file.size)}</small></span>
                <button aria-label={`Remove attachment ${file.name}`} disabled={running} onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}><X size={13} /></button>
              </div>
            ))}
          </section>

          <details className="task-limits">
            <summary><ShieldCheck size={13} /> Permissions for this task</summary>
            <p>Select before Run. One approval covers these limits; blocked actions stop the task.</p>
            {([
              ['unrestrictedNavigation', 'Browse across websites'],
              ['submitForms', 'Submit forms / sign in'],
              ['sensitiveInputs', 'Enter passwords or sensitive values'],
              ['consequentialActions', 'Send, purchase, publish, or delete']
            ] as Array<[keyof TaskCapabilities, string]>).map(([key, label]) => (
              <label key={key}><input type="checkbox" checked={capabilities[key]} disabled={running} onChange={(event) => setCapabilities((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>
            ))}
            {!capabilities.unrestrictedNavigation && <label className="allowed-sites"><span>Additional allowed sites (comma separated)</span><input value={settings.allowlist.join(', ')} disabled={running} onChange={(event) => updateSettings('allowlist', event.target.value.split(',').map((host) => host.trim()))} /></label>}
            <small>Sites named in your task are included. Explicit “do not” restrictions still apply. Only attached files or exact paths in your task may be uploaded.</small>
          </details>

          {error && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button>
            </div>
          )}

          <div className="examples">
            <span className="small-label">Try a mission</span>
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => setTask(example)} disabled={running}>
                <span>{example}</span><ChevronRight size={14} />
              </button>
            ))}
          </div>

          <div className="safety-card">
            <div className="safety-icon"><ShieldCheck size={18} /></div>
            <div>
              <strong>Approval-first</strong>
              <p>Approve once when the task starts. The run then proceeds without per-action interruptions.</p>
            </div>
          </div>

          {settingsOpen && (
            <div className="settings-sheet" id="run-settings">
              <div className="settings-heading">
                <span>Run settings</span>
                <button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={15} /></button>
              </div>
              <label>
                <span>Provider</span>
                <select
                  value={settings.provider}
                  onChange={(event) => selectProvider(event.target.value as ModelProvider)}
                  disabled={running || credentialBusy}
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.value} value={provider.value}>{provider.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span><KeyRound size={13} /> API key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={credential?.provider === settings.provider && credential.configured
                    ? 'Leave blank to keep the connected key'
                    : `Paste your ${providerLabel(settings.provider)} API key`
                  }
                  autoComplete="off"
                  spellCheck={false}
                  disabled={running || credentialBusy}
                />
                <small>
                  {credential?.configured
                    ? `${providerLabel(credential.provider)} configured from ${credential.source === 'stored' ? 'encrypted local storage' : 'an environment variable'}. Actual inference is checked when the task runs.`
                    : 'No provider key is connected.'
                  }
                </small>
              </label>
              <label>
                <span>Model ID</span>
                <input
                  value={settings.model}
                  maxLength={160}
                  spellCheck={false}
                  placeholder={`Paste an exact ${providerLabel(settings.provider)} model ID`}
                  onChange={(event) => updateSettings('model', event.target.value)}
                  disabled={running || credentialBusy}
                />
                <small>Tool calling is required. {credential?.supportsImages ? 'Screenshot input is enabled.' : 'Page text and controls are used without images.'}</small>
                {settings.provider === 'nvidia' && <small>Paste the NVIDIA-hosted model ID exactly. A model available through OpenRouter may use a different ID here.</small>}
              </label>
              {credentialError && <div className="setup-error compact" role="alert"><AlertTriangle size={13} /> {credentialError}</div>}
              <div className="provider-actions">
                <button
                  type="button"
                  className="save-provider-button"
                  onClick={() => void saveProvider(false)}
                  disabled={running || credentialBusy}
                >
                  {credentialBusy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
                  Validate & save
                </button>
                {credential?.source === 'stored' && (
                  <button
                    type="button"
                    className="remove-provider-button"
                    onClick={() => void removeProvider()}
                    disabled={running || credentialBusy}
                  >
                    Remove key
                  </button>
                )}
              </div>
              <label>
                <span>Step limit</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={settings.maxSteps}
                  disabled={running}
                  onChange={(event) => updateSettings('maxSteps', Number(event.target.value))}
                />
              </label>
            </div>
          )}
        </aside>

        <section className="browser-stage">
          <div className="browser-card">
            <div className="browser-chrome">
              <div className="window-dots"><i /><i /><i /></div>
              <div className="address-bar">
                <LockKeyhole size={13} />
                <span>{currentUrl}</span>
              </div>
              <div
                className={`live-chip ${running && hasLiveFrame ? 'active' : ''}`}
                aria-live="polite"
              >
                <span /> {running && hasLiveFrame ? 'VERIFIED VIEW' : 'PREVIEW'}
              </div>
            </div>
            {running && currentUrl === 'about:blank' && <div className="planning-notice" role="status"><LoaderCircle className="spin" size={15} /><div><strong>{latestProgress?.title || 'Preparing the approved task'}</strong><p>{latestProgress?.detail || 'Chrome starts before the model chooses a website. Watch Activity for the request status, or press Stop to cancel.'}</p></div></div>}
            <div className="viewport">
              {latestScreenshot ? (
                <img ref={liveImageRef} src={latestScreenshot} alt="Latest browser-agent screenshot" />
              ) : (
                <div className="empty-viewport">
                  <div className="orbit one" />
                  <div className="orbit two" />
                  <div className="empty-icon"><Globe2 size={35} /></div>
                  <strong>Your agentic browser is ready</strong>
                  <p>The latest verified screenshot will appear here.</p>
                  <div className="capabilities">
                    <span><Navigation size={13} /> Navigate</span>
                    <span><MousePointerClick size={13} /> Interact</span>
                    <span><Eye size={13} /> Verify</span>
                  </div>
                </div>
              )}
            </div>
            <div className="browser-footer">
              <span><span className={`pulse ${running ? 'on' : ''}`} /> {latestTitle}</span>
              <span><MousePointerClick size={13} /> Visible cursor + click trail</span>
            </div>
          </div>

          <div className="architecture-strip">
            <div><span>01</span><strong>Observe</strong><small>DOM + screenshot</small></div>
            <ArrowRight size={15} />
            <div><span>02</span><strong>Reason</strong><small>Goal-aware plan</small></div>
            <ArrowRight size={15} />
            <div><span>03</span><strong>Act</strong><small>Guarded tools</small></div>
            <ArrowRight size={15} />
            <div><span>04</span><strong>Verify</strong><small>Visual artifact</small></div>
          </div>
        </section>

        <aside className="activity-panel">
          <div className="activity-heading">
            <div>
              <span className="section-label"><ScrollText size={14} /> Activity</span>
              <strong>{showDownloads ? 'Your downloadable files' : 'Agent timeline'}</strong>
            </div>
            <span className="event-count">{showDownloads ? downloads.length : events.length}</span>
          </div>

          <div className="activity-tabs">
            <button aria-pressed={!showDownloads} onClick={() => setShowDownloads(false)}>Activity</button>
            <button aria-pressed={showDownloads} onClick={() => { setShowDownloads(true); void window.browserAgent.listDownloads().then(setDownloads).catch((downloadError) => setError(messageFrom(downloadError, 'Unable to load downloads.'))) }}><FileDown size={13} /> Downloads</button>
          </div>

          {showDownloads ? <div className="download-list">
            <p>Generated formats: Excel, Word, PDF, TXT, Markdown, CSV, JSON, and HTML. Files remain here across tasks.</p>
            {downloads.length === 0 && <p>No files yet. Ask Aster to create or download a document.</p>}
            {downloads.map((file) => <article className="download-item" key={file.path}>
              <strong>{file.name}</strong>
              <small>{formatBytes(file.size)} · {new Date(file.createdAt).toLocaleString()}</small>
              <div className="artifact-actions">
                <button aria-label={`Open ${file.name}`} onClick={() => void openArtifact(file.path)}><ExternalLink size={12} /> Open</button>
                <button aria-label={`Download ${file.name}`} onClick={() => void saveArtifactAs(file.path)}><FileDown size={12} /> Download</button>
              </div>
            </article>)}
          </div> : <div className="timeline">
            {events.length === 0 ? (
              <div className="empty-timeline">
                <TerminalSquare size={25} />
                <strong>No activity yet</strong>
                <p>Actions, decisions, approvals, and screenshots will be recorded here.</p>
              </div>
            ) : (
              [...events].reverse().map((event) => (
                <article key={event.id} className={`timeline-event ${event.type}`}>
                  <div className="event-icon"><EventIcon event={event} /></div>
                  <div className="event-body">
                    <div>
                      <strong>{event.title}</strong>
                      <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                    </div>
                    {event.detail && <p>{event.detail}</p>}
                    {event.step !== undefined && <span className="step-tag">step {event.step}</span>}
                    {event.artifactPath && (
                      <div className="artifact-actions">
                        <button
                          type="button"
                          onClick={() => void openArtifact(event.artifactPath!)}
                          aria-label={`Open ${event.title}`}
                        >
                          <ExternalLink size={12} /> Open
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveArtifactAs(event.artifactPath!)}
                          aria-label={`Save ${event.title} as a file`}
                        >
                          <FileDown size={12} /> Save as
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>}

          <div className="privacy-note">
            <LockKeyhole size={14} />
            <span>One task approval covers the run; cursor actions and every tab are recorded.</span>
          </div>
        </aside>
      </main>

      {approval && (
        <div className="modal-backdrop" role="presentation">
          <section className="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
            <div className={`approval-symbol ${approval.risk}`}><ShieldCheck size={23} /></div>
            <span className="risk-label">{approval.risk} risk · user decision</span>
            <h2 id="approval-title">{approval.title}</h2>
            <p>{approval.reason}</p>
            <div className="action-preview">
              <span>Proposed action</span>
              <strong>{approval.preview}</strong>
            </div>
            {approval.rememberable && (
              <label className="remember-row">
                <input
                  type="checkbox"
                  checked={rememberApproval}
                  onChange={(event) => setRememberApproval(event.target.checked)}
                />
                <span>Remember this approval for the current run</span>
              </label>
            )}
            <div className="modal-actions">
              <button ref={denyButtonRef} className="deny-button" onClick={() => void decide(false)}><X size={16} /> Deny</button>
              <button className="approve-button" onClick={() => void decide(true)}>
                <Check size={16} /> {approval.action === 'approve_run' ? 'Approve task' : 'Approve once'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default App

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}
