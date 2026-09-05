import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskPermissionScope } from '../src/main/run-permissions'
import type { BrowserAction, BrowserElement } from '../src/shared/types'

const action = (
  name: BrowserAction['name'],
  args: Record<string, unknown> = {},
  callId = 'call-1'
): BrowserAction => ({ name, arguments: args, callId })

describe('task-scoped permission', () => {
  it('denies every action until the run receives its one approval', () => {
    const scope = new TaskPermissionScope('Search for MrBeast on YouTube.')

    expect(scope.isGranted()).toBe(false)
    expect(scope.authorize(action('navigate', { url: 'https://youtube.com' })).allowed).toBe(false)

    scope.grant()
    expect(scope.isGranted()).toBe(true)
  })

  it('keeps a long in-scope workflow non-interactive after approval', () => {
    const scope = new TaskPermissionScope('Research three products and summarize the results.')
    scope.grant()

    const decisions = Array.from({ length: 500 }, (_, index) =>
      scope.authorize(action(index % 2 === 0 ? 'inspect_page' : 'list_tabs', {}, `call-${index}`))
    )

    expect(decisions).toHaveLength(500)
    expect(decisions.every((decision) => decision.allowed)).toBe(true)
  })

  it('allows only an upload path explicitly written in the approved task', () => {
    const approvedPath = path.resolve('C:\\work\\quarterly report.pdf')
    const scope = new TaskPermissionScope(`Upload "${approvedPath}" to the reporting portal.`)
    scope.grant()

    expect(scope.authorize(action('upload_file', { path: approvedPath })).allowed).toBe(true)
    expect(
      scope.authorize(action('upload_file', { path: path.resolve('C:\\work\\secrets.pdf') })).allowed
    ).toBe(false)
  })

  it('does not mistake a longer filename for approval of its prefix', () => {
    const requestedPath = path.resolve('C:\\work\\report.pdf')
    const scope = new TaskPermissionScope(`Inspect ${requestedPath}.backup but do not upload anything.`)
    scope.grant()

    expect(scope.authorize(action('upload_file', { path: requestedPath })).allowed).toBe(false)
  })

  it('describes the full grant in the single start-of-run approval', () => {
    const scope = new TaskPermissionScope('Book the requested appointment.')
    const preview = scope.approvalPreview()

    expect(preview).toContain('Task: Book the requested appointment.')
    expect(preview).toContain('One approval covers this run')
    expect(preview).toContain('consequential actions')
    expect(preview).toContain('exact local path')
  })

  it('requires explicit capabilities for sensitive inputs, form submissions, and consequential clicks', () => {
    const button: BrowserElement = { ref: 'e1', tag: 'button', role: 'button', name: 'Delete account', type: 'submit', sensitive: false, disabled: false }
    const password: BrowserElement = { ...button, tag: 'input', role: 'input', name: 'Password', type: 'password', sensitive: true }
    const scope = new TaskPermissionScope('Inspect the account.')
    scope.grant()
    expect(scope.authorize(action('click', { ref: 'e1' }), button).allowed).toBe(false)
    expect(scope.authorize(action('type_text', { ref: 'e1', text: 'secret' }), password).allowed).toBe(false)
    expect(scope.authorize(action('press_key', { key: 'Enter' })).allowed).toBe(false)

    const approved = new TaskPermissionScope('Delete my account after signing in.', [], {
      submitForms: true, sensitiveInputs: true, consequentialActions: true
    })
    approved.grant()
    expect(approved.authorize(action('click', { ref: 'e1' }), button).allowed).toBe(true)
    expect(approved.authorize(action('type_text', { ref: 'e1', text: 'secret' }), password).allowed).toBe(true)
  })

  it('keeps explicit restrictions even when the corresponding capability was selected', () => {
    const button: BrowserElement = { ref: 'e1', tag: 'button', role: 'button', name: 'Delete account', type: 'button', sensitive: false, disabled: false }
    for (const task of ['Read-only account review.', 'Inspect the account. Do not submit forms or delete anything.']) {
      const scope = new TaskPermissionScope(task, [], { submitForms: true, sensitiveInputs: true, consequentialActions: true })
      scope.grant()
      expect(scope.authorize(action('click', { ref: 'e1' }), button).allowed).toBe(false)
      expect(scope.authorize(action('press_key', { key: 'Enter' })).allowed).toBe(false)
    }
  })

  it('accepts multiple selected attachments but rejects the entire batch if any path is unapproved', () => {
    const approvedPaths = [path.resolve('sample.pdf'), path.resolve('sample.custom')]
    const scope = new TaskPermissionScope('Upload the attachments.', approvedPaths)
    scope.grant()
    expect(scope.authorize(action('upload_file', { paths: approvedPaths })).allowed).toBe(true)
    expect(scope.authorize(action('upload_file', { paths: [...approvedPaths, path.resolve('private.txt')] })).allowed).toBe(false)
    expect(scope.authorize(action('upload_file', { paths: [] })).allowed).toBe(false)
    expect(scope.authorize(action('upload_file', { paths: ['relative.txt'] })).allowed).toBe(false)
    const noUpload = new TaskPermissionScope('Do not upload these attachments.', approvedPaths)
    noUpload.grant()
    expect(noUpload.authorize(action('upload_file', { paths: approvedPaths })).allowed).toBe(false)
  })

  it('allows ordinary searching without allowing arbitrary Enter submissions', () => {
    const scope = new TaskPermissionScope('Search for browser testing information.')
    scope.grant()
    const search: BrowserElement = { ref: 'e1', tag: 'input', role: 'input', name: 'Search', type: 'search', sensitive: false, disabled: false }
    expect(scope.authorize(action('press_key', { key: 'Enter' }), search).allowed).toBe(true)
    expect(scope.authorize(action('press_key', { key: 'Enter' })).allowed).toBe(false)
    const article: BrowserElement = { ...search, tag: 'a', role: 'link', type: undefined, name: 'How to send a message', href: 'https://example.com/post/123' }
    expect(scope.authorize(action('click', { ref: 'e1' }), article).allowed).toBe(true)
  })
})
