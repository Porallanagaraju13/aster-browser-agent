import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { expectedDeliverables, verifyDeliverables } from '../src/main/deliverables'

describe('requested output verification', () => {
  const directories: string[] = []
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
  it('distinguishes attachments from requested output formats', () => {
    expect(expectedDeliverables('Upload resume.pdf to the site.')).toEqual({ required: false, formats: [] })
    expect(expectedDeliverables('Upload resume.pdf and create a DOCX summary.')).toEqual({ required: true, formats: ['docx'] })
    expect(expectedDeliverables('Read the attached PDF and create a summary.')).toEqual({ required: false, formats: [] })
    expect(expectedDeliverables('Provide the details in an Excel sheet and a PDF document.')).toEqual({ required: true, formats: ['xlsx', 'pdf'] })
    expect(expectedDeliverables('Create a report.').required).toBe(true)
    expect(expectedDeliverables('Create a PowerPoint file.').formats).toEqual(['pptx'])
  })
  it('requires nonempty real outputs in the current run and requested formats', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aster-deliverables-'))
    directories.push(directory)
    const runDir = path.join(directory, 'run')
    await mkdir(runDir)
    const text = path.join(runDir, 'report.txt')
    const empty = path.join(runDir, 'empty.pdf')
    const outside = path.join(directory, 'outside.pdf')
    await Promise.all([writeFile(text, 'A report'), writeFile(empty, ''), writeFile(outside, 'Not generated in this run')])
    expect(await verifyDeliverables(runDir, { required: true, formats: ['txt'] }, [text], [text])).toBeUndefined()
    expect(await verifyDeliverables(runDir, { required: true, formats: ['pdf'] }, [text], [])).toContain('pdf')
    expect(await verifyDeliverables(runDir, { required: true, formats: [] }, [empty, outside], [])).toContain('not created')
    expect(await verifyDeliverables(runDir, { required: false, formats: [] }, [text], [outside])).toContain('could not be verified')
  })
})
