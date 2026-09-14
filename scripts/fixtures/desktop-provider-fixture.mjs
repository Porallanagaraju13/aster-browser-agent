import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export const DESKTOP_PROVIDER_CASES = {
  openrouter: { label: 'OpenRouter', catalog: 'https://openrouter.ai/api/v1/models', endpoint: 'https://openrouter.ai/api/v1/chat/completions', tokenParameter: 'max_tokens' },
  groq: { label: 'Groq', catalog: 'https://api.groq.com/openai/v1/models', endpoint: 'https://api.groq.com/openai/v1/chat/completions', tokenParameter: 'max_completion_tokens' },
  nvidia: { label: 'NVIDIA', catalog: 'https://integrate.api.nvidia.com/v1/models', endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', tokenParameter: 'max_tokens' },
}

export async function startDesktopProviderFixture(provider) {
  const spec = DESKTOP_PROVIDER_CASES[provider]
  assert.ok(spec)
  const model = `fixture/${provider}-text-tools`
  const key = `fixture-${provider}-never-real`
  const entered = `${spec.label} Tester`
  const state = { requests: [], actions: [], entered: '', verified: false, initialObservation: undefined, error: '', mode: 'success', failedRequests: 0, artifactPath: '' }
  let origin
  const action = (name, args) => {
    state.actions.push(name)
    return { id: `fixture-response-${state.actions.length}`, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `fixture-call-${state.actions.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/mock-provider' && request.method === 'POST') {
        let wire = ''
        for await (const chunk of request) {
          wire += chunk
          if (wire.length > 8 * 1024 * 1024) throw new Error('Fixture payload exceeded safe size')
        }
        const envelope = JSON.parse(wire)
        assert.equal(envelope.authorization, `Bearer ${key}`, 'Expected only the synthetic test key')
        state.requests.push({ method: envelope.method, url: envelope.url })
        if (envelope.method === 'GET') {
          assert.ok(envelope.url === spec.catalog || (provider === 'openrouter' && envelope.url === 'https://openrouter.ai/api/v1/key'), 'Unexpected catalog endpoint')
          assert.ok(!envelope.body, 'Catalog validation must not issue paid inference')
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(envelope.url.endsWith('/key') ? { data: { is_free_tier: true } } : { data: [{ id: model, active: true, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] }, input_modalities: ['text'] }] }))
          return
        }
        assert.equal(envelope.method, 'POST')
        assert.equal(envelope.url, spec.endpoint, 'Inference used the wrong provider API path')
        const payload = JSON.parse(envelope.body)
        assert.equal(payload.model, model, 'Exact user-supplied model ID was not preserved')
        assert.ok(Number.isInteger(payload[spec.tokenParameter]) && payload[spec.tokenParameter] > 0, 'Wrong provider-specific token parameter')
        assert.equal(payload[spec.tokenParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'], undefined, 'Do not send conflicting token fields')
        assert.equal(payload.stream ?? false, false)
        assert.equal(payload.tool_choice, 'auto')
        assert.equal(payload.parallel_tool_calls, provider === 'nvidia' ? undefined : false)
        const toolNames = payload.tools.map(tool => tool.function?.name)
        for (const name of ['navigate', 'type_text', 'click', 'save_file', 'finish']) assert.ok(toolNames.includes(name), `Missing browser tool: ${name}`)
        const parts = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text))
        assert.ok(!JSON.stringify(payload.messages).includes(key), 'Provider authentication must not appear in model context')
        assert.ok(!payload.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')), 'Text-only provider received an image')
        // NVIDIA's compatible endpoint may merge adjacent user turns into one string.
        const observationMarker = /(?:CURRENT BROWSER OBSERVATION|LATEST VERIFIED BROWSER OBSERVATION):\s*\n/
        const observationText = [...parts].reverse().find(text => observationMarker.test(text))
        assert.ok(observationText, 'Missing semantic browser observation')
        const marker = observationText.match(observationMarker)
        const observation = JSON.parse(observationText.slice(marker.index + marker[0].length))
        const previous = [...payload.messages].reverse().find(message => message.role === 'tool')
        if (!previous) {
          state.initialObservation = observation
          // Startup branding is UI-only, never represented as external website data.
          assert.equal(observation.url, 'about:blank')
          assert.equal(observation.title, '')
          assert.equal(observation.visibleText, '')
          assert.deepEqual(observation.interactiveElements, [])
        }
        if (state.mode === 'failure') {
          state.failedRequests++
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: `Synthetic credential rejection for ${key}` } }))
          return
        }
        let next
        if (!previous) {
          assert.equal(state.actions.length, 0, 'Unexpected repeated initial inference')
          next = action('navigate', { url: `${origin}/fixture` })
        } else {
          const result = JSON.parse(previous.content)
          assert.equal(result.ok, true, `Browser action ${previous.name} did not succeed`)
          assert.equal(observation.url, `${origin}/fixture`, 'The browser never reached the real local page')
          if (previous.name === 'navigate') {
            const input = observation.interactiveElements.find(item => item.name === 'Display name')
            assert.ok(input, 'No actual input observed')
            next = action('type_text', { ref: input.ref, text: entered })
          } else if (previous.name === 'type_text') {
            const button = observation.interactiveElements.find(item => item.name === 'Show greeting')
            assert.ok(button, 'No actual button observed')
            next = action('click', { ref: button.ref })
          } else if (previous.name === 'click' || previous.name === 'inspect_page') {
            if (state.entered !== entered || !observation.visibleText.includes(`Hello, ${entered}.`)) next = action('inspect_page', {})
            else {
              state.verified = true
              next = action('save_file', { filename: `${provider}-verified-report.txt`, format: 'txt', content: `Provider: ${spec.label}\nVerified result: Hello, ${entered}.\nSource: ${origin}/fixture` })
            }
          } else if (previous.name === 'save_file') {
            assert.equal(typeof result.data?.path, 'string', 'File tool did not return an artifact path')
            state.artifactPath = result.data.path
            next = action('finish', { outcome: 'completed', summary: `Verified the local greeting and created ${provider}-verified-report.txt.`, artifactPaths: [state.artifactPath] })
          } else throw new Error(`Unexpected fixture action ${previous.name}`)
        }
        assert.ok(state.actions.length <= 10, 'Fixture exceeded bounded browser actions')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(next))
      } else if (request.url?.startsWith('/confirmed?')) {
        state.entered = new URL(request.url, origin).searchParams.get('name') ?? ''
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}')
      } else if (request.url === '/fixture') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'" })
        response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Desktop provider verification</title><style>body{font:22px system-ui;max-width:760px;margin:60px auto}input,button{font:inherit;margin:12px;padding:12px}</style></head><body><h1>Desktop provider verification</h1><label>Display name<input aria-label="Display name" type="text"></label><button type="button">Show greeting</button><p id="result">Waiting for the agent.</p><script>document.querySelector('button').addEventListener('click',async()=>{const name=document.querySelector('input').value;await fetch('/confirmed?name='+encodeURIComponent(name));document.getElementById('result').textContent='Hello, '+name+'.';});</script></body></html>`)
      } else { response.writeHead(404); response.end() }
    } catch (error) {
      state.error = error instanceof Error ? error.message.replaceAll(key, '[synthetic key hidden]') : 'Unknown fixture error'
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: state.error } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    spec, model, key, entered, origin, state,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}

export async function installDesktopProviderStub(application, fixture) {
  const allowed = [fixture.spec.catalog, fixture.spec.endpoint, ...(fixture.spec.label === 'OpenRouter' ? ['https://openrouter.ai/api/v1/key'] : [])]
  await application.evaluate((_electron, options) => {
    const nativeFetch = globalThis.__asterTestNativeFetch
    if (typeof nativeFetch !== 'function') throw new Error('Pre-startup test network guard was not installed')
    globalThis.__asterUnexpectedProviderRequests = 0
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (!options.allowed.includes(request.url)) {
        globalThis.__asterUnexpectedProviderRequests++
        throw new Error('Desktop test blocked an unexpected provider endpoint')
      }
      // The only actual Node fetch is to this exact owned loopback fixture.
      return nativeFetch(options.target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), body: request.method === 'GET' ? '' : await request.text() }), signal: request.signal, redirect: 'error' })
    }
  }, { allowed, target: `${fixture.origin}/mock-provider` })
}
