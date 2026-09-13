import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function reserveInspectorPort() {
  const reservation = createSocketServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  return port
}

export async function connectMainInspector(port) {
  const deadline = Date.now() + 30_000
  let endpoint
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) })
      const targets = await response.json()
      endpoint = targets[0]?.webSocketDebuggerUrl
      if (endpoint) break
    } catch { /* The portable bootstrapper may still be extracting Electron. */ }
    await delay(200)
  }
  if (!endpoint) throw new Error('The portable application did not expose its test-only Node inspector on loopback.')
  if (typeof WebSocket === 'undefined') throw new Error('The portable smoke test requires Node.js 22 or newer for its local inspector connection.')
  const socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Node inspector connection timed out.')), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Unable to connect to the owned Node inspector.')) }, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (message) => {
    const response = JSON.parse(String(message.data))
    const call = pending.get(response.id)
    if (!call) return
    pending.delete(response.id)
    clearTimeout(call.timeout)
    if (response.error) call.reject(new Error(response.error.message))
    else call.resolve(response.result)
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Node inspector ${method} timed out.`))
    }, 15_000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return {
    async evaluate(expression) {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
      return response.result?.value
    },
    async close() {
      for (const request of pending.values()) {
        clearTimeout(request.timeout)
        request.reject(new Error('Node inspector closed.'))
      }
      pending.clear()
      socket.close()
      await Promise.race([
        new Promise((resolve) => socket.addEventListener('close', resolve, { once: true })),
        delay(1_000)
      ])
    }
  }
}

export async function startPortableBrowserFixture() {
  const state = { providerRequests: 0, actions: [], enteredName: '', verified: false, error: '' }
  let origin
  const action = (name, args) => {
    state.actions.push(name)
    const sequence = state.providerRequests
    return {
      id: `portable-smoke-${sequence}`,
      status: 'completed',
      steps: [{ type: 'function_call', id: `call-${sequence}`, name, arguments: args }]
    }
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/mock-provider' && request.method === 'POST') {
        let body = ''
        for await (const chunk of request) {
          body += chunk
          if (body.length > 8 * 1024 * 1024) throw new Error('Mock provider request exceeded its local test limit.')
        }
        const payload = JSON.parse(body)
        state.providerRequests++
        if (state.providerRequests > 8) throw new Error('The deterministic portable task exceeded eight provider requests.')
        const previous = payload.input?.find((item) => item.type === 'function_result')
        let next
        if (!previous) {
          if (state.providerRequests !== 1) throw new Error('Unexpected repeated initial model request.')
          next = action('navigate', { url: `${origin}/fixture` })
        } else {
          const result = JSON.parse(previous.result.find((item) => item.type === 'text').text)
          if (result.ok !== true) throw new Error(`Portable browser action ${previous.name} failed: ${result.message}`)
          const observation = result.browser_observation
          if (previous.name === 'navigate') {
            const input = observation.interactiveElements.find((item) => item.name === 'Display name')
            if (!input) throw new Error('The packaged browser did not observe the fixture input.')
            next = action('type_text', { ref: input.ref, text: 'Portable Tester' })
          } else if (previous.name === 'type_text') {
            const button = observation.interactiveElements.find((item) => item.name === 'Show greeting')
            if (!button) throw new Error('The packaged browser did not observe the fixture button.')
            next = action('click', { ref: button.ref })
          } else if (['click', 'inspect_page'].includes(previous.name)) {
            if (state.enteredName !== 'Portable Tester' || !observation.visibleText.includes('Hello, Portable Tester.')) {
              next = action('inspect_page', {})
            } else {
              state.verified = true
              next = action('finish', { outcome: 'completed', summary: 'Verified the local greeting after navigating, entering the display name, and clicking Show greeting.' })
            }
          } else throw new Error(`Unexpected portable smoke action ${previous.name}.`)
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(next))
      } else if (request.url?.startsWith('/confirmed?')) {
        state.enteredName = new URL(request.url, origin).searchParams.get('name') || ''
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      } else if (request.url === '/fixture') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><html><head><title>Portable browser verification</title></head><body>
          <h1>Portable browser verification</h1>
          <label>Display name <input aria-label="Display name" type="text"></label>
          <button type="button">Show greeting</button><p id="result">Waiting for the agent.</p>
          <script>document.querySelector('button').addEventListener('click', async () => {
            const name = document.querySelector('input').value;
            await fetch('/confirmed?name=' + encodeURIComponent(name));
            document.getElementById('result').textContent = 'Hello, ' + name + '.';
          });</script></body></html>`)
      } else {
        response.writeHead(404)
        response.end()
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: state.error } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin, state,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
