# Aster Chrome Extension v0.1.1 — direct Google Gemini beta

Google Gemini now works directly in Aster's Chrome side panel, alongside OpenRouter and Groq. Use your own Google AI Studio API key and exact supported Gemini text/chat-model ID. No OpenRouter key, desktop app, backend or `.env` file is required.

## Browser actions, not just chat

Gemini proposes the same validated actions as the other providers: read the approved page, navigate within approved websites, click, type, select options, scroll, press supported keys and upload selected files. Ask for real downloadable Excel, Word, PDF and text reports. Actions run on the selected browser tab with visible indicators.

This adds a direct Gemini model connection, **not Gemini Native/computer-use mode**. Task approval, allowed websites, Stop, tab-switch cancellation and bounded runs remain in place. The desktop v0.12.1 application is unchanged.

## Download and update

1. Download **Aster-Chrome-Extension-0.1.1.zip** from this release's Assets, not GitHub's source-code ZIP.
2. Stop any running task and download files you want to keep. Extract the ZIP into a permanent folder.
3. For an existing unpacked installation, replace the packaged files in its folder and click **Reload** at `chrome://extensions`. Alternatively, remove the old extension, enable **Developer mode**, choose **Load unpacked**, and select the new folder containing `manifest.json`. Do not leave two versions enabled.
4. Confirm version **0.1.1** and review the newly added Google API host permission.
5. Open Aster on a website. In **Settings → Google Gemini**, paste your own Google AI Studio key and exact supported model ID, then save. An optional leading `models/` prefix is removed automatically. Approve your task and start.

Keys are session-only: paste the key again after Chrome restarts or the extension reloads. Switching providers clears the entered key/model to prevent sending a key to the wrong provider. Provider charges, quotas and account restrictions apply; model availability is not assumed.

This is a **public GitHub unpacked release**, not a published Chrome Web Store listing. Unpacked installations do not update automatically.

## Privacy and security

Gemini requests go directly over HTTPS to Google's fixed API endpoint with Bearer authentication, never through OpenRouter. Keys are excluded from model prompts and page actions; this update also adds Google-key-shaped redaction, including trailing-character edge cases. Redaction remains best effort, not a guarantee.

Google's paid and unpaid services have different data-handling terms. Review the [Gemini API terms](https://ai.google.dev/gemini-api/terms) and Aster's [privacy policy](https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/PRIVACY.md) before sharing page or attachment content. Do not send sensitive data to a service whose terms are inappropriate for it.

## Verification and limitations

183 extension unit tests and 89 desktop regression tests pass. All three providers pass isolated Chromium 149 browser checks using real DOM actions and valid XLSX/PDF/DOCX downloads with mocked AI responses. They cover provider selection/authentication, non-editable input protection, navigation, typing, select, Enter, click, upload, scroll, Stop, quota handling and accessibility, with no unexpected network requests or page errors. The native Gemini side-panel smoke check passes using the unchanged production manifest, including session-key storage and panel-close lifecycle.

No real API key or paid live-model call was used. Browser action tests pregrant only a synthetic localhost origin in a disposable manifest copy; Chrome's native optional-permission prompt still needs manual verification. This is not a guarantee for every live model, website or operating system.

Only the approved active tab is automated. Protected pages, frames, CAPTCHAs, popups and trusted-input-only controls can need manual interaction. PDF supports Latin/Windows-1252; use Word/TXT for Telugu and other scripts. Download generated files before closing the panel. Review consequential actions and all generated data.

See [setup and limitations](https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/README.md) and the [public-store checklist](https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/STORE_SUBMISSION.md).

## Integrity

ZIP size: **2,185,279 bytes**.

SHA-256 (`Aster-Chrome-Extension-0.1.1.zip`):

```text
9bfaee7c35a3010d9e66429966eaf3007c9684f79a0b21bd0d19bde533d0a6e5
```

The companion `Aster-Chrome-Extension-0.1.1-SHA256.txt` contains the same checksum. The ZIP contains only bundled extension files and dependency notices, not API keys, source maps, development tools or browser profiles. The historical v0.1.0 release is unchanged.
