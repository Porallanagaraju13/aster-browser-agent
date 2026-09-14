# Direct Gemini provider — extension v0.1.1

Approved request: add a Google Gemini API-key/model option that operates the browser through Aster's existing validated actions, and publish an updated extension. Gemini Native/computer-use mode is not being restored.

## Implementation

1. Add `gemini` provider using Google's documented OpenAI-compatible chat-completions endpoint, fixed Google host, Bearer authentication and JSON action output. No new SDK or arbitrary endpoint.
2. Add Google Gemini settings choice/model hint; preserve atomic session-only credentials and correct provider restoration. Extend secret redaction and key-leak guards for Google keys.
3. Permit only the Google API host in extension network/CSP configuration. Preserve tab scope, approvals, Stop, uploads and generated documents.
4. Test Gemini requests/errors/session settings and run the same actual browser action/export flow through all three mocked provider endpoints. Native side-panel UI remains a separate unchanged-manifest smoke test.
5. Version 0.1.1, update install/privacy/store docs, build/package, scan release, push and publish a new checksummed GitHub beta release. Do not replace immutable v0.1.0 assets.

## Verification boundaries

Use synthetic data and mock model replies for repeatable browser-action tests; no real secret or paid API call without an explicitly provided testing key/authorization. Be explicit that this is direct Gemini planning plus local browser actions, not unrestricted browser access. Chrome Web Store account/review requirements remain unchanged.

Reference: https://ai.google.dev/gemini-api/docs/openai
