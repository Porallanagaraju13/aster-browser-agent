# Aster Chrome Extension v0.1.0 — public beta

A standalone Aster side panel for desktop Chrome. No Windows EXE, desktop app, backend, Node.js or `.env` file is required to use it.

## Download and install

Download **Aster-Chrome-Extension-0.1.0.zip** from this release's Assets. Extract it into a permanent folder. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the extracted folder containing `manifest.json`.

Open a website and click Aster's toolbar icon. Choose **OpenRouter or Groq**, paste your own API key and exact model ID, then describe and approve a task. Keys are session-only; re-enter after restarting Chrome or reloading the extension. Provider charges may apply.

This is a **public GitHub unpacked release**, not a Chrome Web Store listing. Store publication remains a separate publisher-account and Google-review step.

## Included

- Side-panel workspace using the current approved tab and visible click/fill/scroll indicators; no mirrored browser or screenshot-stream blinking.
- Scoped navigation, validated editable inputs, fresh semantic references, select controls, supported keys and user-approved uploads.
- One reviewed task scope, immediate cancellation of further work on Stop/tab switch, bounded runs and clear errors.
- Real downloadable XLSX, DOCX, PDF, TXT, MD, CSV, JSON and inert HTML files.
- Up to 10 attachments, 10 MiB each / 20 MiB total; bounded text/DOCX/XLSX reading, other binaries upload-only.
- No bundled key, Aster server, telemetry, arbitrary model JavaScript, cookies or debugger permission.

## Verification and limitations

151 extension tests and 89 desktop regression tests pass. Real isolated Chromium tests verify browser controls, approved upload, file downloads, Stop, quota errors and the actual native side-panel lifecycle. AI responses are mocked; this is not a claim that every live model/website works. Native optional-permission prompts need manual verification; the headless workflow pregrants only a test localhost origin in a disposable manifest copy. The production manifest is unchanged for the separate side-panel test.

Beta supports only the selected active tab. Protected pages, frames, CAPTCHAs, popups and trusted-input-only widgets may need manual interaction. PDF export supports Latin/Windows-1252; use Word/TXT for Telugu and other scripts. Review consequential actions and generated data. Closing the panel stops the task and clears unsaved panel data; download files first.

See [setup and full limitations](https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/README.md), [privacy](https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/PRIVACY.md), and [public-store checklist](https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/STORE_SUBMISSION.md).

## Integrity

ZIP size: 2,185,059 bytes.

SHA-256 (`Aster-Chrome-Extension-0.1.0.zip`):

```text
790239b00cc550765a7cf9818e33d9a5853781156577710ca25192d672993d85
```

The companion `Aster-Chrome-Extension-0.1.0-SHA256.txt` asset contains the same checksum. The archive includes only bundled extension files and dependency notices, not source, development tools, keys or profiles.
