# Aster · User & Developer Guide

[← Back to Aster](../README.md) · [Download v0.12.2](https://github.com/Porallanagaraju13/aster-browser-agent/releases/tag/v0.12.2)

This guide covers the Windows edition's configuration, browser behavior, file handling, permissions, development, and packaging. For the ready-to-run Windows application, download the portable `.exe` from the release page, not GitHub's source-code ZIP. The repository and release downloads are public. For the standalone Chrome edition, see [the extension guide](../extension/README.md).

Aster is a local desktop browser agent modeled on the observable behavior of Google Antigravity's browser subagent. Give it an outcome and it opens a visible, isolated Chrome profile alongside an embedded verified preview, lets the connected AI model inspect a screenshot plus a semantic page map, executes one guarded browser action, captures evidence, and repeats until the outcome is verified.

It is an independent project—not a Google product and not affiliated with Antigravity.

## Implemented capabilities

- First-run provider setup for Google Gemini, OpenRouter, Groq, or NVIDIA NIM, with a user-entered API key and model ID.
- API keys encrypted locally with Electron `safeStorage` (Windows DPAPI on the Windows build), kept out of plaintext settings and redacted from event logs. Screenshots, recordings and website outputs can still contain visible secrets; treat artifacts as private.
- Google uses its native Interactions API. OpenRouter, Groq and NVIDIA use their hosted OpenAI-compatible tool-calling APIs. NVIDIA defaults to text/controls unless image support is explicitly verified in its catalog.
- Tool loop: every action returns fresh page state; verified vision models also receive screenshots. Text-only tool models use DOM observations.
- Direct Chrome control through Playwright/CDP; no extension is required.
- Stable browser preview updated only from verified observations, without continuous or cursor-time screenshot capture that can flash the visible Chrome surface.
- Smooth visible agent cursor, target highlight, and click ripple in Chrome and the recordings.
- Persistent, isolated browser profile that never opens your regular Chrome profile.
- Multiple tabs: create, list, switch, close, and observe the active tab.
- Navigation, back, forward, reload, click, type, hover, scroll, keyboard, select, checkbox/radio, and wait controls.
- Correct handling for JavaScript-backed in-page controls (common in older portals) while non-HTTP external schemes remain blocked.
- Guarded file downloads and multiple-file uploads from native **Attach files** selection or exact paths in the approved task. Hidden file inputs, iframes, and open shadow roots are supported.
- Formatted `.xlsx` export for verified page tables, saved inside the run artifacts without another permission prompt.
- Downloadable Word, Unicode PDF, text, Markdown, CSV, JSON, and safe HTML exports, with **Open** and **Save as** controls. The **Downloads** section persists files across tasks and app restarts. Duplicate filenames are versioned, not overwritten.
- Viewport and full-page screenshots plus automatic per-tab WebM video recording.
- One task approval with selected navigation, form, sensitive-input, and consequential-action limits. Stop cancels model work and waits for browser cleanup before another task can start.
- Explicit incomplete results for step exhaustion, missing requested files, refusals, or blocked actions. Requested output formats are checked against nonempty files created in that run.
- JSONL event log, Markdown result, sequential screenshots, recordings, and downloaded files for every run.
- Prompt-injection boundary that treats page content as untrusted data rather than agent instructions.

Google documents Antigravity as controlling Chrome through a separate profile and producing screenshot/video artifacts. Aster implements those user-visible patterns locally. Antigravity's private server-side malicious-URL service, proprietary agent runtime, and internal Google integrations are not available to third-party applications, so they cannot be copied exactly.

## Architecture

```text
Electron renderer
  mission · verified preview · task approval · timeline · downloadable artifacts
                         │ context-isolated IPC
                         ▼
Electron main process
  ├─ AgentRunner          approve task → observe → act → verify
  ├─ Model planners       Gemini Interactions or OpenAI-compatible tools + vision
  ├─ TaskPermissionScope  one-run grant + exact-path upload gate
  └─ BrowserController    Playwright → cursor overlay + visible Chrome
                                  │
                                  ▼
                  isolated persistent + recorded Chrome profile
```

Page controls receive short refs such as `e12`. The model uses those refs instead of inventing brittle CSS selectors. Every navigation or large page change produces a new map.

## Browser tool surface

| Area | Tools |
|---|---|
| Page | `navigate`, `inspect_page`, `reload`, `go_back`, `go_forward` |
| Interaction | `click`, `type_text`, `hover`, `select_option`, `check`, `scroll`, `press_key`, `wait` |
| Tabs | `new_tab`, `list_tabs`, `switch_tab`, `close_tab` |
| Files and evidence | `download`, `save_spreadsheet`, `save_file`, `upload_file`, `screenshot`; automatic video |
| Lifecycle | `finish`, user stop, step limit |

## Requirements

For the portable Windows application:

- Windows x64
- Google Chrome, or `CHROME_PATH` pointing to a compatible Chromium executable
- Internet access
- An API key for Google Gemini, OpenRouter, Groq, or NVIDIA NIM
- A model ID that supports function/tool calling; image input is optional for OpenAI-compatible providers

No backend files, Node.js installation, Python installation, or `.env` file are needed to run the portable application. Each recipient enters their own provider key and model on first launch.

For source development, also install Node.js 20 or newer and run `npm ci`. The portable smoke-test script requires Node.js 22 or newer. Build Windows x64 releases on Windows; packaging downloads the recording runtime using the lockfile-installed Playwright CLI.

Enter the exact model ID listed by your chosen provider for your account. The model must support function/tool calling; image input is optional for OpenAI-compatible providers. Model availability and pricing belong to the provider and can change. Aster checks provider/model metadata before saving credentials; this is not a paid inference test or a guarantee of current quota, credits or tool behavior. A key from one provider cannot be used with another provider's endpoint.

## Run it

```powershell
git clone https://github.com/Porallanagaraju13/aster-browser-agent.git
cd aster-browser-agent
npm ci
npm run dev
```

On first launch, choose **Google Gemini**, **OpenRouter**, **Groq**, or **NVIDIA NIM**, paste the provider's API key, enter the exact model ID, and select **Validate and continue**. Aster encrypts the key with the operating system and never returns it to the renderer after storage. Provider, model, and key can be replaced later in Settings.

For development automation, `GEMINI_API_KEY`/`GEMINI_MODEL`, `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`, `GROQ_API_KEY`/`GROQ_MODEL`, and `NVIDIA_API_KEY`/`NVIDIA_MODEL` are also supported. NVIDIA requires an explicit model ID. Environment keys are not copied into project settings unless the user explicitly validates and saves that provider from the UI.

## Provider setup and startup troubleshooting

For direct NVIDIA, create your own hosted API key at [NVIDIA's API Catalog](https://build.nvidia.com/), choose **NVIDIA NIM** in Aster and paste an exact tool-capable model ID from that catalog. No local NVIDIA GPU or NIM container is needed. A model routed through OpenRouter can have a different ID from the same model hosted by NVIDIA. The key goes only to the selected provider's fixed endpoint. NVIDIA's model catalog is public: passing catalog validation confirms the model ID, **not** that your key works. The first approved task checks inference access and displays an authentication error if the provider rejects the key. Review [NVIDIA's API documentation](https://docs.api.nvidia.com/nim/reference/llm-apis), [terms](https://developer.nvidia.com/terms-of-use) and [privacy policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/) before sharing task/page data. No free-tier availability or zero-retention promise is made.

The desktop app launches its separate, isolated Chrome window **before** asking the model for its first action. A slow, queued, failed or non-tool model response can therefore leave the browser at `about:blank`; this does not by itself mean Chrome or the internet is broken. Version 0.12.2 displays a static local waiting page and request progress instead of an unexplained white page. The waiting page contains no task text or credentials. The browser navigates only after the model returns an allowed navigation action.

If there are no actions, check **Activity** and the visible error banner. Authentication, unavailable models, quota/credits, unsupported requests and missing tool calls require different remedies. Verify provider and exact model, narrow the task, or choose a model with documented tool calling. Use **Stop** to cancel; this cannot undo actions already sent. Do not remove task-approval checks or disable browser security to troubleshoot an API problem. A separate Chrome window is expected for the desktop edition; the Chrome extension instead controls the selected tab.

Login identifiers, passwords, tokens, and other credentials written in a task remain available to the browser agent for that approved run, but their values are redacted from the event timeline, `events.jsonl`, and `summary.md`. Page screenshots and recordings can still show whatever the website itself renders, so treat run artifacts as private.

## First test

1. Enter: `Open https://example.com, verify the heading visually, and explain what the page is for.`
2. Select **Run agent**, review the complete task scope, and select **Approve task** once.
3. Let Aster complete the browser workflow without further permission dialogs.
4. Use **Open** or **Save as** on a timeline artifact, or open **Artifacts** to inspect all screenshots, files, WebM recordings, `events.jsonl`, and `summary.md`.

For local application testing, `localhost` and `127.0.0.1` are allowed by default.

## Upload files and receive documents

1. Choose **Attach files** and select the files you want the agent to upload to a website. Any extension is allowed, up to 20 files, 100 MB per file, and 500 MB total. Website file-type and single/multiple-file restrictions still apply.
2. Describe the destination and requested result, for example: `Upload the attached documents to the form on https://your-site.example, then create an Excel summary and a Word report.`
3. Open **Permissions for this task** and enable form submission, sensitive fields, or consequential actions only if needed. Select **Run agent** and approve the displayed limits once.
4. Open **Downloads** to open a result or save a copy. Excel (`xlsx`), Word (`docx`), PDF, TXT, Markdown, CSV, JSON, and HTML can be generated. Downloaded website files retain their original format. Unsupported generated formats produce an incomplete result, not a renamed substitute.

Attachments authorize browser uploads; attaching a file does not automatically send its contents to the model or imply support for reading every document format. The task, file paths, page content and (for vision models) screenshots are sent to the selected provider. Uploaded bytes are sent to the destination website. PDF generation uses a hidden, network-isolated Chromium renderer with system font fallback for multilingual text.

## Commands

```powershell
npm run dev          # Launch the desktop app
npm run typecheck    # Check main, preload, renderer, and tests
npm test             # Run policy and real-Chrome integration tests
npm run test:e2e     # Build and run the production Electron/accessibility journey
npm run test:e2e:providers # Mock AI matrix with real browser actions for OpenRouter/Groq/NVIDIA
npm run test:e2e:file # Run a live Gemini request that must create a Word artifact
npm run test:e2e:documents # Test attachments, Unicode PDF, Save as and persistent downloads without paid model calls
npm run build        # Create production bundles in out/
npm run package:win  # Create a portable Windows build in release/
npm run test:portable # Test the actual packaged EXE, browser actions and recording with an empty external cache
```

## Windows application

Run `npm run package:win`, then open the generated `Aster-Browser-Agent-*-Windows-x64.exe` in the `release` folder. It is a portable desktop application: double-click it directly, with no Node.js command or installer required. The executable and application window use the Aster icon from `build/icon.ico`.

Share only that generated portable EXE, not the inner `win-unpacked` executable. The portable file includes the app's backend, Electron runtime, and Playwright FFmpeg recording executable. It still requires an installed Google Chrome browser; Chrome is not bundled. API keys, settings, browser profiles, and task artifacts are created separately on each recipient's computer and must not be shared with the application.

The packaging hook installs the matching FFmpeg/Windows helper into the ignored `build/playwright-runtime` directory, validates executable and license files, and includes them outside `app.asar`. A bootstrap sets the packaged runtime location before importing Playwright, so recording never depends on the developer's global browser cache. Build-cache `.links` metadata is excluded. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for recording-runtime notices.

Run `npm run test:portable` after packaging. This launches the actual portable file from an empty working directory and fresh profile, with an unavailable external Playwright cache. A deterministic local mock provider drives a real Chrome navigation, text entry, and click; the test requires a completed task and nonempty WebM recording. It does not contact paid AI providers. This is an isolated-dependency check on the test PC, not a substitute for a separate Windows-machine acceptance test. The executable remains unsigned, so Windows may show a publisher warning.

## Live cursor and preview

After task approval, Aster opens its dedicated Chrome window normally. It uses the native window viewport instead of forcing a fixed emulated viewport, which avoids display-scale surface changes on Windows. Before an interaction, Aster smoothly moves a high-contrast cursor to the target, outlines the target, and displays a lime click ripple in visible Chrome and the recorded WebM evidence. The embedded panel updates from the verified observation after each action. Aster does not capture rapid cursor frames or continuously screenshot an idle browser, so Chrome is not repeatedly repainted while the agent works. App status indicators stay steady instead of blinking.

The cursor respects the operating system's reduced-motion preference. Pause-and-takeover is a planned feature, not a currently available control; see [ENHANCEMENTS.md](../ENHANCEMENTS.md). Use **Stop** to end the current run before starting a different task.

## Approval model

Aster asks once per run before browser startup. **Permissions for this task** selects the limits shown in that approval: browsing across websites, submitting forms/signing in, entering sensitive values, and consequential actions. Form, sensitive-input, and consequential permissions are off by default. With cross-site browsing disabled, domains in the task and additional allowlist are permitted; other main-frame navigations and redirects are blocked before requests. Detected actions outside the approved limits stop the run without another prompt.

The permission expires when the run ends. Local uploads must be attached with the native picker or named by exact resolved paths in the approved task. Missing or different paths are denied; files are revalidated before dispatch. Unsupported URL schemes, URLs with embedded credentials, oversized uploads, and non-regular files remain blocked.

## Security boundary

This is a guarded agent, not a perfect sandbox. Action classification relies on observable controls and cannot prove what arbitrary website scripts will do. Websites can be adversarial and model interpretation can be wrong. Keep tasks narrow, enable only needed permissions, and monitor important work. File existence/format checks do not prove the factual accuracy or completeness of generated content; review the documents before relying on them.

## Production validation

Before packaging a release, run `npm test`, `npm run test:e2e`, `npm run test:e2e:providers`, and `npm audit`. The Electron journeys verify first-run provider onboarding, Google/OpenRouter/Groq/NVIDIA choices, masked credentials, automatic visible-browser operation, the task approval lifecycle, stable verified previews, downloadable-artifact controls, renderer error monitoring, keyboard behavior, and automated WCAG 2.1 AA checks. Run suites sequentially on resource-constrained machines.

Downloads are isolated to each run's artifact folder. The Downloads view lists at most 500 recent files from the newest 100 runs; older files remain on disk. The dedicated browser profile persists cookies between runs, and screenshots/recordings may contain sensitive page content.

Deterministic tests cover cancellation races, missing outputs, multiple-file upload to a real local fixture, generated XLSX/DOCX contents, provider response truncation, Unicode PDF text extraction, and downloads after restart. These do not replace live validation of each user's provider/key/model. Very large exports beyond the bounded model output capacity fail explicitly; streaming/chunked generation is not yet implemented. The Windows portable build remains unsigned.

## Primary references

- [Google Antigravity browser documentation](https://antigravity.google/docs/browser)
- [Antigravity allowlist and denylist](https://antigravity.google/docs/ide/allowlist-denylist/)
- [Gemini API function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Google Gen AI JavaScript SDK](https://googleapis.github.io/js-genai/)
- [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
- [Groq API reference](https://console.groq.com/docs/api-reference)
- [Groq vision and tool use](https://console.groq.com/docs/vision)
- [NVIDIA hosted LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis)
