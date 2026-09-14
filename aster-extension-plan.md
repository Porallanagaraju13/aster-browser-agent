# Aster browser extension plan

Build a standalone Chrome Manifest V3 extension beside the existing Electron app. Public GitHub ZIP is the first deployment; Chrome Web Store publication is a separate, user-account-dependent review process.

## Scope and decisions

- React + TypeScript + Vite side panel, existing charcoal/lime Aster branding.
- OpenRouter and Groq with user-supplied key and exact model ID. Keys are session-only, never sent to web pages or committed.
- Agent loop lives in the visible side panel, not a transient service worker. Closing the panel stops the task. A Web Lock prevents concurrent runs across panels.
- One task approval covers its goal, chosen tab, explicit allowed website origins, optional form submission and attached files. No silent access to unrelated tabs, cookies or local files.
- Semantic page observations and validated DOM actions, visible cursor/click indicators, refresh after every step, bounded execution and Stop. No screenshot streaming or repeated page reloads.
- Local browser-side TXT/MD/CSV/JSON/HTML/PDF/DOCX/XLSX generation and user-selected attachments. Arbitrary binaries may be uploaded, but only supported text/document formats are parsed.
- No arbitrary model-generated JavaScript, debugger permission, remote code, telemetry, server or desktop dependency.

## Work breakdown

1. [x] Root: scaffold extension package, shared contracts, build and packaging.
2. [x] Browser specialist: isolated DOM command function, scoped Chrome controller, cursor overlay and tests.
3. [x] Agent specialist: provider validation/request handling, strict action schema, bounded agent loop and tests.
4. [x] Documents specialist: attachment handling, local downloadable document builders and tests.
5. [x] Root: onboarding, task approval, progress, Stop, file library and settings UI.
6. [x] Test assembled extension in isolated Chromium with mock AI, run unit/regression tests, inspect build/security and package manifest.
7. [x] Prepare checksummed unpacked ZIP, public GitHub release metadata, setup, privacy and store-submission documents. Publication is recorded by the `extension-v0.1.0` GitHub release.

## Verification

- 151 extension unit/integration tests; 89 existing desktop regression tests pass.
- Actual Chromium 149 extension-page workflow: editable-target rejection, fill, click, approved upload, real XLSX/PDF/DOCX downloads, Stop and quota handling; no page errors or accessibility violations in the checked Files view.
- Actual Chrome SIDE_PANEL context: creation, settings interaction and destruction/pagehide on close, using unchanged production manifest.
- Headless workflow uses a temporary manifest copy with only the local fixture origin pregranted; native host-permission prompts need manual verification. Production ZIP has no test host, mock provider or test hooks.
- Production dependency audit reports zero known vulnerabilities at build time; this is not a security guarantee. Model responses were mocked, not a live paid-model evaluation.

## Acceptance and limits

- Clean install -> key/model setup -> scoped task -> inspect/type/click -> verified result -> downloadable XLSX/report.
- Reject stale refs and non-editable fill targets; reject unapproved origin navigation and sensitive operations by default; enforce cancellation and step limit.
- Package includes only bundled extension assets; no `.env`, keys, profiles, source maps or desktop dependencies.
- Verify real extension APIs, not just mocked UI. Record remaining website-specific limitations truthfully (CAPTCHAs, closed shadow DOM, cross-origin frames, trusted-input-only controls).
- Never mark Chrome Web Store publication complete until the listing is actually approved/live.
