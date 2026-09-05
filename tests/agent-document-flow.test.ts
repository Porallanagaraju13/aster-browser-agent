import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { expect, it, vi } from 'vitest'
import { AgentRunner } from '../src/main/agent-runner'
import type { ActionResult, AgentEvent, ApprovalRequest, BrowserAction, PageObservation } from '../src/shared/types'
import type { BrowserPlanner, PlannerTurn } from '../src/main/planner'

const mocked = vi.hoisted(() => ({ createPlanner: vi.fn() }))
vi.mock('../src/main/planner', () => ({ createPlanner: mocked.createPlanner }))
vi.mock('../src/main/browser-controller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/browser-controller')>()
  return {
    ...actual,
    BrowserController: class extends actual.BrowserController {
      constructor(options: ConstructorParameters<typeof actual.BrowserController>[0]) {
        super({ ...options, headless: true })
      }
    }
  }
})

it('uploads approved attachments and delivers verified Excel and Word outputs after one approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aster-document-flow-'))
  const attachments = [path.join(root, 'source.txt'), path.join(root, 'distributors.csv')]
  const sourceNote = 'Verified from the attached agency source.'
  const sourceCsv = 'Distributor,Contact\nFixture Medicals,2025550100\n'
  await Promise.all([
    writeFile(attachments[0], sourceNote, 'utf8'),
    writeFile(attachments[1], sourceCsv, 'utf8')
  ])
  const canonicalAttachments = await Promise.all(attachments.map((file) => realpath(file)))

  type UploadedFile = { name: string; size: number; text: string }
  let uploaded: UploadedFile[] = []
  const server = createServer((request, response) => {
    if (request.url === '/received' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        uploaded = JSON.parse(body) as UploadedFile[]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Agency document fixture</title></head><body>
      <h1>Agency document fixture</h1>
      <input type="file" aria-label="Attach source documents" multiple hidden accept=".txt,.csv">
      <p id="status">Waiting for approved attachments.</p><p id="note"></p><table id="records"></table>
      <script>
        document.querySelector('input').addEventListener('change', async (event) => {
          const files = await Promise.all([...event.target.files].map(async (file) => ({
            name: file.name, size: file.size, text: await file.text()
          })));
          await fetch('/received', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(files) });
          document.getElementById('status').textContent = 'Uploaded ' + files.length + ' source files: ' + files.map(file => file.name).join(', ');
          document.getElementById('note').textContent = files.find(file => file.name.endsWith('.txt')).text;
          for (const line of files.find(file => file.name.endsWith('.csv')).text.trim().split('\\n')) {
            const row = document.createElement('tr');
            for (const value of line.split(',')) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
            document.getElementById('records').append(row);
          }
        });
      </script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const events: AgentEvent[] = []
  const approvals: ApprovalRequest[] = []
  const savedPaths: string[] = []
  let verifiedRows: string[][] = []
  let verifiedNote = ''
  let sawOutputsAtCompletion = false
  let actionNumber = 0
  const action = (name: BrowserAction['name'], args: Record<string, unknown>): PlannerTurn => ({
    responseId: `response-${++actionNumber}`, message: '', actions: [{ name, arguments: args, callId: `call-${actionNumber}` }]
  })

  const planner: BrowserPlanner = {
    begin: vi.fn(async (task: string) => {
      expect(task).toContain('Attached files available for website upload')
      canonicalAttachments.forEach((file) => expect(task).toContain(JSON.stringify(file)))
      return action('navigate', { url: origin })
    }),
    continue: vi.fn(async (_id: string, outputs: Array<{ action: BrowserAction; result: ActionResult }>, observation: PageObservation) => {
      expect(outputs).toHaveLength(1)
      const previous = outputs[0]
      expect(previous.result.ok, previous.result.message).toBe(true)
      if (previous.action.name === 'navigate') {
        const control = observation.elements.find((element) => element.name === 'Attach source documents')
        expect(control?.type).toBe('file')
        return action('upload_file', { ref: control!.ref, paths: attachments })
      }
      if (previous.action.name === 'upload_file' || previous.action.name === 'inspect_page') {
        if (previous.action.name === 'upload_file') expect(previous.result.data?.count).toBe(2)
        if (!observation.text.includes('Uploaded 2 source files')) return action('inspect_page', {})
        const sourceRow = observation.text.split('\n').find((line) => line.includes('Fixture Medicals'))
        expect(sourceRow).toBeDefined()
        verifiedRows = [sourceRow!.trim().split(/\t+/)]
        expect(verifiedRows).toEqual([['Fixture Medicals', '2025550100']])
        verifiedNote = observation.text.split('\n').find((line) => line === sourceNote) ?? ''
        expect(verifiedNote).toBe(sourceNote)
        return action('save_spreadsheet', { filename: 'verified-distributors.xlsx', columns: ['Distributor', 'Contact'], rows: verifiedRows })
      }
      if (previous.action.name === 'save_spreadsheet') {
        savedPaths.push(String(previous.result.data?.path))
        return action('save_file', {
          filename: 'verified-report.docx', format: 'docx', title: 'Verified distributor report',
          content: `${verifiedNote}\n${verifiedRows[0][0]} — ${verifiedRows[0][1]}`
        })
      }
      expect(previous.action.name).toBe('save_file')
      savedPaths.push(String(previous.result.data?.path))
      return action('finish', { outcome: 'completed', summary: 'Uploaded both sources and created the requested Excel and Word files.', artifactPaths: [...savedPaths] })
    })
  }
  mocked.createPlanner.mockReturnValue(planner)
  const runner = new AgentRunner({
    artifactsRoot: path.join(root, 'artifacts'), profileDir: path.join(root, 'profile'),
    emitEvent: (event) => {
      events.push(event)
      if (event.status === 'completed') {
        sawOutputsAtCompletion = events.filter((item) => item.metadata?.downloadable === true).length === 2
      }
    },
    emitApproval: (request) => {
      approvals.push(request)
      runner.resolveApproval(request.id, true, false)
    },
    emitLiveFrame: () => undefined
  })

  try {
    const started = await runner.start({
      task: `Upload the attached source files to ${origin}; then provide an Excel spreadsheet and a Word document with the verified distributor contact details.`,
      apiKey: 'fake-integration-key', provider: 'google', model: 'mocked-planner',
      maxSteps: 10, allowlist: ['127.0.0.1'], attachments
    })
    expect(started.ok).toBe(true)
    await vi.waitFor(() => expect(events.some((event) => ['completed', 'incomplete', 'failed', 'stopped'].includes(event.status ?? ''))).toBe(true), { timeout: 45_000, interval: 50 })
    const terminal = events.filter((event) => event.status).at(-1)!
    expect(terminal.status, terminal.detail).toBe('completed')
    expect(sawOutputsAtCompletion).toBe(true)
    expect(approvals).toHaveLength(1)
    expect(approvals[0].preview).toContain('attached files (2)')
    expect(uploaded).toEqual([
      { name: 'source.txt', size: Buffer.byteLength(sourceNote), text: sourceNote },
      { name: 'distributors.csv', size: Buffer.byteLength(sourceCsv), text: sourceCsv }
    ])
    expect(savedPaths).toHaveLength(2)
    for (const file of savedPaths) expect(path.dirname(file)).toBe(path.join(root, 'artifacts', started.runId!, 'downloads'))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(savedPaths[0])
    expect(workbook.getWorksheet('Results')?.getCell('A2').value).toBe('Fixture Medicals')
    expect(workbook.getWorksheet('Results')?.getCell('B2').value).toBe('2025550100')
    const docxBytes = await readFile(savedPaths[1])
    expect(docxBytes.subarray(0, 2).toString()).toBe('PK')
    const docx = await JSZip.loadAsync(docxBytes)
    const documentXml = await docx.file('word/document.xml')!.async('string')
    expect(documentXml).toContain(sourceNote)
    expect(documentXml).toContain('Fixture Medicals')
    expect(documentXml).toContain('2025550100')
    const summary = await readFile(path.join(root, 'artifacts', started.runId!, 'summary.md'), 'utf8')
    expect(summary).toContain('Status: completed')
    expect(summary).toContain('verified-distributors.xlsx')
    expect(summary).toContain('verified-report.docx')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  } finally {
    await runner.stop()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
