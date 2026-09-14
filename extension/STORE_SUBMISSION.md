# Public Chrome Web Store submission

Status: **prepared for submission; not published in the Chrome Web Store.** Developer mode is local unpacked installation, not a publisher account. The owner selected a public listing.

## Owner steps that remain

1. Sign in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) with the intended publisher account. Register/verify it if needed. The owner must handle any fee, identity verification and agreement acceptance.
2. Supply/verify the publisher support email and update the contact section of `PRIVACY.md`. Review that policy and all data-use declarations for accuracy.
3. Upload `Aster-Chrome-Extension-0.1.0.zip` (manifest at ZIP root), not the repository source ZIP or Windows EXE.
4. Add a 128×128 store icon and actual product screenshots in the dashboard’s required dimensions. The existing extension icon is bundled; confirm/resample marketing assets using the store requirements. Automated synthetic-data screenshots can be used only with clear demo labeling; never upload screenshots containing a real API key or customer data.
5. Set distribution to **Public**, complete the listing/privacy/practices/reviewer instructions, and submit for review. Record the live listing URL only after approval. Do not claim store approval from a successful ZIP upload alone.

Official guidance: [Publishing](https://developer.chrome.com/docs/webstore/publish), [Privacy policies](https://developer.chrome.com/docs/webstore/program-policies/privacy), [Remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Suggested listing

**Name:** Aster — Browser Agent

**Short description:** Use your own AI key to work in the current tab, see browser actions, and create downloadable documents from a side panel.

**Detailed description:**

Aster puts a task-based AI assistant beside the website you are using. Connect your own OpenRouter or Groq account, paste an exact chat-model ID, describe a task and review its website access before starting.

Watch visible click and typing indicators on the page. Aster can read page content, fill supported fields, navigate within approved websites, select options, scroll and upload files you selected. Ask for results as real Excel, Word, PDF, text or structured-data files and download them from the Files view.

No desktop app or Aster server is required. API requests go directly to your selected provider, and your key stays in browser-session memory. Provider usage charges may apply. Closing the panel stops the task. This beta supports a single active tab; protected pages, CAPTCHAs, frames and some website controls require manual interaction. Review all results and consequential actions.

**Category:** Productivity (select the matching current dashboard category).

**Homepage/support:** https://github.com/Porallanagaraju13/aster-browser-agent

**Privacy policy URL:** https://github.com/Porallanagaraju13/aster-browser-agent/blob/main/extension/PRIVACY.md

## Single purpose and permissions

Single purpose: carry out the user’s approved browser task and produce task deliverables in a side panel using their own AI provider.

| Permission | User-facing reason |
| --- | --- |
| sidePanel | Keep the task workspace next to the website. |
| activeTab | Identify/access the user-selected tab after invoking Aster. |
| scripting | Execute bundled, validated DOM observation/action code on the approved tab. No model-generated code is evaluated. |
| storage | Save provider/model preferences and hold the key in trusted-context-only session memory. |
| downloads | Save locally generated user-requested documents. |
| openrouter.ai, api.groq.com | Authenticate and send user-approved task context directly to the chosen AI provider. |
| Optional HTTP(S) host access | Request only the origins entered in the task approval. Needed to operate and navigate user-selected websites. Runtime scope remains checked even after Chrome retains a grant. |

No remotely hosted executable code, debugger, cookies, all-tab history, native messaging, web-accessible resources or content-script message command bridge is included.

## Data-use/reviewer notes

Declare the data categories actually processed, including website content, user task/attachment content and API authentication data. Do not tick “does not collect or transmit user data”: direct transfers to an AI provider still count as data handling. Account for incidental personal/sensitive information in user-approved page content. State no sale, advertising or unrelated collection; confirm all assertions against the final uploaded package.

Review setup requires the reviewer’s compatible OpenRouter/Groq key and model. Do not place a paid unrestricted publisher API key in the public ZIP or listing. If the store requests test credentials, arrange a limited test method privately with the account owner. The included automated tests use mock AI and are not a production demo mode.
