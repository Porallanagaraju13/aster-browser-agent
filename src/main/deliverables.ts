import path from 'node:path'
import { stat } from 'node:fs/promises'
import { resolveArtifactFile } from './artifact-access'

export interface DeliverableExpectation {
  required: boolean
  formats: string[]
}

/** Detect output requests, not input files mentioned in upload/read instructions. */
export function expectedDeliverables(task: string): DeliverableExpectation {
  const outputText = task.replace(/\b(?:upload|attach|read|open|inspect|analy[sz]e|summari[sz]e)\b[^;\n]*?(?=\b(?:and|then)\b|[;\n]|$)/gi, ' ')
  if (!/\b(?:create|generate|write|provide|export|save|download|prepare|make|give|return|deliver|need|want)\b/i.test(outputText)) {
    return { required: false, formats: [] }
  }
  const formats: string[] = []
  const checks: Array<[string, RegExp]> = [
    ['xlsx', /\b(?:xlsx|excel|spreadsheet)\b/i],
    ['pdf', /\bpdf\b/i],
    ['docx', /\b(?:docx|word)\b/i],
    ['csv', /\bcsv\b/i],
    ['json', /\bjson\b/i],
    ['html', /\bhtml\b/i],
    ['md', /\b(?:markdown|md)\b/i],
    ['txt', /\b(?:txt|text file)\b/i],
    ['pptx', /\b(?:pptx|powerpoint)\b/i],
    ['odt', /\bodt\b/i]
  ]
  for (const [format, pattern] of checks) if (pattern.test(outputText)) formats.push(format)
  return { required: formats.length > 0 || /\b(?:document|file|downloadable|report)\b/i.test(outputText), formats }
}

export async function verifyDeliverables(
  runDir: string,
  expectation: DeliverableExpectation,
  producedPaths: string[],
  claimedPaths: unknown
): Promise<string | undefined> {
  const actual = new Set<string>()
  for (const produced of producedPaths) {
    try {
      const canonical = await resolveArtifactFile(runDir, produced)
      if ((await stat(canonical)).size > 0) actual.add(canonical)
    } catch { /* Missing, empty, and out-of-run files are not deliverables. */ }
  }
  if (Array.isArray(claimedPaths)) {
    for (const claimed of claimedPaths) {
      if (typeof claimed !== 'string') return 'The model returned invalid file evidence.'
      try {
        if (!actual.has(await resolveArtifactFile(runDir, claimed))) return 'A claimed output file was not created by this task.'
      } catch { return 'A claimed output file could not be verified.' }
    }
  }
  if (expectation.required && actual.size === 0) return 'The requested downloadable document was not created.'
  const extensions = new Set([...actual].map((file) => path.extname(file).slice(1).toLowerCase()))
  const missing = expectation.formats.filter((format) => !extensions.has(format))
  if (missing.length) return `Missing requested output format(s): ${missing.join(', ')}. No substitute format was counted as completion.`
  return undefined
}
