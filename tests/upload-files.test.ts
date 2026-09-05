import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requestedUploadPaths, validateUploadFiles, validateWebsiteUpload } from '../src/main/upload-files'

describe('attachment validation', () => {
  it('accepts arbitrary extensions and multiple real files without allowing directories or missing files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aster-upload-files-'))
    try {
      const paths = ['report.pdf', 'data.xlsx', 'archive.zip', 'custom.unknown'].map((name) => path.join(root, name))
      await Promise.all(paths.map((filePath) => writeFile(filePath, 'fixture')))
      expect(await validateUploadFiles(paths)).toHaveLength(4)
      expect(requestedUploadPaths({ path: paths[0] })).toEqual([paths[0]])
      const directory = path.join(root, 'directory')
      await mkdir(directory)
      await expect(validateUploadFiles([directory])).rejects.toThrow('not a regular file')
      await expect(validateUploadFiles([path.join(root, 'missing.pdf')])).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects ambiguous or unbounded path input before accessing the disk', () => {
    expect(() => requestedUploadPaths({ paths: [] })).toThrow('between 1 and 20')
    expect(() => requestedUploadPaths({ paths: ['relative.txt'] })).toThrow('absolute')
    expect(() => requestedUploadPaths({ paths: Array.from({ length: 21 }, (_, i) => path.resolve(`${i}.txt`)) })).toThrow('between 1 and 20')
    expect(() => requestedUploadPaths({ paths: [42] })).toThrow('nonempty absolute')
  })

  it('respects the website multiple and accept attributes with useful errors', () => {
    expect(() => validateWebsiteUpload(['a.pdf', 'b.pdf'], { multiple: false, accept: '' })).toThrow('only one file')
    expect(() => validateWebsiteUpload(['a.pdf', 'b.xlsx'], { multiple: true, accept: '.pdf,.xlsx' })).not.toThrow()
    expect(() => validateWebsiteUpload(['a.png'], { multiple: false, accept: 'image/*' })).not.toThrow()
    expect(() => validateWebsiteUpload(['a.pdf'], { multiple: false, accept: 'image/*' })).toThrow('accepted types')
    expect(() => validateWebsiteUpload(['custom.unknown'], { multiple: false, accept: '' })).not.toThrow()
    expect(() => validateWebsiteUpload(['a.docx'], { multiple: false, accept: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).not.toThrow()
  })
})
