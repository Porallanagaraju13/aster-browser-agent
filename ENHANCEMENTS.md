# Aster enhancement roadmap

## Recommended next milestone

1. **Pause and take over** — pause the model while the user interacts directly with the visible Chrome window, then resume from a fresh screenshot and DOM map. This prevents user and agent input from racing.
2. **Self-healing actions** — when a ref becomes stale, re-inspect and recover the target using role, accessible name, nearby text, and visual position before asking the model to retry.
3. **Outcome assertions** — let tasks declare observable success conditions and require the agent to collect evidence for each one before finishing.
4. **Secure credential vault** — store site credentials with OS-backed encryption and release individual values only to approved origins and fields.
5. **Task templates** — reusable workflows with typed inputs for research, QA, form entry, downloads, and local-app testing.

## Reliability and safety

- Detect stalled pages, login walls, CAPTCHAs, detached elements, and navigation loops with specific recovery paths.
- Add per-task policy profiles such as research-only, form-entry, authenticated, and consequential-action modes.
- Redact configured sensitive regions and values from screenshots, logs, model messages, and recordings.
- Add domain reputation checks and stricter handling of downloads before opening any downloaded file.
- Provide a replayable action trace with the exact observation, decision, action, and verification for every step.

## Performance and scale

- Move each browser session into an isolated worker process so crashes and memory growth cannot affect the desktop shell.
- Add adaptive live-preview quality: increase frame rate during pointer motion and reduce it while idle.
- Compact long model histories into verified state summaries while retaining raw artifacts locally.
- Add a local task queue with configurable concurrency, per-session profiles, and CPU/memory limits.
- Store large recordings and screenshots behind a retention policy instead of keeping every artifact forever.

## Product and deployment

- Add signed installers, automatic updates, release channels, and crash recovery.
- Add a browser-session viewer with pause, rewind, step-by-step replay, and exportable reports.
- Add optional extension or CDP attachment for controlling an already-open browser profile with explicit consent.
- Add provider adapters so the planner can be swapped without changing browser-control code.
- Add team policy management, shared task templates, and centralized run observability for managed deployments.
