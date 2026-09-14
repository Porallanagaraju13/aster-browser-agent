# Aster Chrome Extension — Privacy Policy

Effective date: September 14, 2026. Applies to extension v0.1.1, not the separate desktop application.

## Purpose and data flow

Aster helps you carry out a user-approved browser task with your own AI provider. It has no Aster backend, advertising or telemetry service.

When you start a task, Aster sends the task prompt, approved page URL/title/text, interactive control labels, bounded prior task evidence and supported attachment text directly over HTTPS to **the provider you selected: OpenRouter, Groq or Google Gemini**. OpenRouter may route requests to an upstream model provider. Selecting Google Gemini sends requests directly to Google, not through OpenRouter. The selected provider’s terms, privacy policy, processing/retention practices and account settings apply. Review [OpenRouter privacy](https://openrouter.ai/privacy), [Groq privacy](https://groq.com/privacy-policy/) or the [Gemini API terms](https://ai.google.dev/gemini-api/terms) before submitting data.

### Direct Gemini and Google's data handling

For Gemini, Aster authenticates with your Google API key at `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, using Google's documented [OpenAI-compatible API](https://ai.google.dev/gemini-api/docs/openai). The Google host permission enables this direct connection; it does not enable Google account access or additional browser-control capabilities. Gemini Native/computer-use mode is not included.

Google distinguishes paid and unpaid Gemini services. Under its unpaid-service terms, inputs and outputs may be used to improve Google products and may receive human review; do not submit sensitive, confidential or personal information to those services. Under its paid-service terms, Google states prompts/responses are not used for product improvement, but safety/security logging still applies. Billing and regional rules affect which terms apply; review the current [Gemini API terms](https://ai.google.dev/gemini-api/terms) for your account. Aster does not choose your billing tier or promise zero retention.

Your API key is sent only as authentication to the fixed selected provider endpoint. It is never included intentionally in webpage commands or model prompts. Password-input values are omitted from page observations, but visible text, URLs, files and user prompts can contain sensitive information; do not submit data you are not authorized to share. Redaction is a best-effort safeguard, not a guarantee.

## Local storage and retention

- The API key is stored in browser-session memory via `chrome.storage.session`, accessible only to trusted extension contexts. It clears on browser restart, extension reload/update/disable, or **Forget API key**. It is not synced and not deliberately persisted in local storage.
- Provider and model preferences are stored locally until changed or the extension is removed.
- Task activity, selected attachments and generated file contents remain in the open panel’s memory. Closing the panel clears this panel data and stops further task work.
- Files you download remain in your chosen download location until you delete them. Chrome may retain download history under your browser settings.
- Website permissions may remain granted after a task; you can revoke them in Chrome’s extension settings or uninstall Aster.

## Website access and attachments

Aster requests access to website origins you approve when starting a task. It acts only on the selected active tab within that runtime scope. Website pages and attachment contents are untrusted inputs. A chosen file is uploaded only through a task upload action using its approved attachment ID; websites may start transfers immediately when their file input changes. Supported attachment text may be sent to the AI provider as task context. No automatic collection of unrelated local files, all-tab browsing history, cookies or passwords from browser storage occurs.

Data is used to provide the user-facing task and not sold, used for advertising or transferred to an Aster analytics service. The selected provider and websites receiving submitted data process it independently. Aster cannot retract data after submission or delete it from third-party services.

## Your choices and contact

You can decline site access, omit attachments, disable submission/sensitive-input capabilities, stop a task, clear the file list, forget the key, revoke site permissions or uninstall the extension. An action already delivered to a website cannot be automatically undone by Stop.

Project contact: [Porallanagaraju13/aster-browser-agent issue tracker](https://github.com/Porallanagaraju13/aster-browser-agent/issues). Do not include secrets or private personal information in a public issue. A separate public support email must be provided by the publisher before the Chrome Web Store listing is submitted; it has not been invented or populated here.
