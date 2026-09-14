# Desktop provider reliability and NVIDIA — v0.12.2

Request: investigate blank browser behavior with OpenRouter and Groq, add NVIDIA API support, and make connection/startup failures actionable. The user clarified that testing in the desktop application opens a separate blank browser tab. Scope is now the Windows desktop application; the extension v0.1.1 is unchanged. The exact user-specific model failure is not yet reproduced.

1. Add NVIDIA's fixed hosted OpenAI-compatible chat/model endpoints, per-provider encrypted credentials and exact model ID. Keep Gemini/OpenRouter/Groq support and task approvals.
2. Audit provider validation versus actual inference capability: correct provider request parameters, tools and text-only support, safe errors, timeouts/cancellation and no key leakage. No automatic paid inference during credential validation.
3. Diagnose browser startup from relevant recent redacted logs and isolated tests. Replace an unexplained initial white tab with a clearly identified local waiting page and visible planning/startup status; preserve navigation safety and do not claim the unknown API account issue is solved merely by changing that page.
4. Update desktop onboarding/settings for NVIDIA and accurately distinguish saved/catalog-validated credentials from a successful task. Preserve existing local UI, visible browser actions and task controls.
5. Test provider wire formats, credentials, lifecycle/race handling and visible failures. Exercise all supported provider/browser paths in isolated Electron/Chromium with mocked AI. Never read stored secrets, personal browser profiles or make paid model calls without explicit testing credentials/authorization.
6. Build and package desktop v0.12.2, update current desktop documentation and publish a new checksummed GitHub release after verification. Preserve historical releases and extension v0.1.1.

Verification must distinguish repaired evidence-backed issues from an unconfirmed user-specific blank-page cause. Remaining live account/model validation limits must be stated.

Verified result: 148 tests across 23 files, all four desktop E2E scripts, final onboarding after wording changes, typecheck/build, and the exact Windows portable EXE smoke test passed. OpenRouter/Groq/NVIDIA task journeys used real local Chrome and mocked AI; the portable mock journey also verified bundled video recording. No personal keys or paid model inference were used. NVIDIA's anonymous model catalog returned HTTP 200, so the UI/docs distinguish catalog lookup from key authentication. A bounded, tested build-time EBUSY/open retry resolved the transient staging-executable lock without changing security settings. Desktop v0.12.2 is packaged and checksummed; extension files and historical releases are unchanged.
