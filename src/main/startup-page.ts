import type { Page } from 'playwright-core'

export const STARTUP_PAGE_TITLE = 'Aster · Browser ready'
const marker = '__aster_local_startup_page__'

// Deliberately static: never interpolate a task, model name, API key, website or file.
export const STARTUP_PAGE_DOCUMENT = Object.freeze({
  title: STARTUP_PAGE_TITLE,
  head: `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
:root{color-scheme:dark;font-family:Segoe UI,Arial,sans-serif;background:#0b100f;color:#eef4ee}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:40px 24px}main{width:min(100%,720px);border:1px solid #2b3830;border-radius:24px;padding:44px;background:#111914}.brand{display:flex;gap:12px;align-items:center;font-size:24px;font-weight:650}.orb{width:34px;height:34px;border-radius:50%;background:#c8ff69;box-shadow:inset -8px -7px 0 #94c343}.eyebrow{margin:38px 0 12px;color:#c8ff69;font-size:12px;letter-spacing:2px}h1{margin:0;font-size:40px;line-height:1.15;letter-spacing:-1px}.lead{margin:18px 0 26px;font-size:19px;line-height:1.55;color:#d2ded3}.stages{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:28px}.stages span{padding:9px 12px;border-radius:8px;background:#1d2b21;color:#d3e4d3;font-size:13px}.stages .waiting{border:1px solid #708f45;background:#25331a;color:#ddf9b3}.help{border-top:1px solid #2b3830;padding-top:24px;line-height:1.6;color:#aebfaf;font-size:15px}.help strong{color:#eef4ee}small{display:block;margin-top:22px;color:#87a08c;font-size:12px;line-height:1.5}@media(max-width:520px){main{padding:28px}h1{font-size:32px}}
</style>`,
  body: `<main id="${marker}" aria-label="Aster local startup screen"><div class="brand"><span class="orb" aria-hidden="true"></span>Aster</div><p class="eyebrow">LOCAL · ISOLATED BROWSER</p><h1>Your browser is ready.</h1><p class="lead">Waiting for your AI provider to choose the first browser action.</p><div class="stages"><span>Task approved</span><span>Browser opened</span><span class="waiting">Waiting for AI instructions</span></div><p class="help">No website has been opened yet. If this screen stays here, check <strong>Aster’s Activity panel</strong> for model-request progress or a connection error. You can stop the task from Aster.</p><small>This is a local waiting screen, not a website or proof that the AI connection succeeded. No task details or credentials are displayed here.</small></main>`,
})

/** Paint only an untouched initial blank document, without any navigation or request. */
export async function showStartupPage(page: Page): Promise<boolean> {
  return page.evaluate(({ title, head, body }) => {
    if (location.href !== 'about:blank' || document.title || !document.head || !document.body || document.head.childElementCount > 0 || document.body.childNodes.length > 0) return false
    // The check and local DOM update share one synchronous browser evaluation, so
    // a navigation cannot race between a separate blank check and setContent().
    document.head.innerHTML = head
    document.title = title
    document.body.innerHTML = body
    document.documentElement.lang = 'en'
    return true
  }, STARTUP_PAGE_DOCUMENT)
}

export async function isStartupPage(page: Page): Promise<boolean> {
  if (page.url() !== 'about:blank') return false
  return page.evaluate(({ title, id }) => location.href === 'about:blank' && document.title === title && document.body?.childElementCount === 1 && document.body.firstElementChild?.id === id, { title: STARTUP_PAGE_TITLE, id: marker })
}
