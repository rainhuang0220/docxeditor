import { apiFetch } from '../utils/api.ts'
import { parsePageSettings, type PageSettings } from './pageSettings.ts'

export interface ImportedDocument {
  ok: true
  html: string
  pageSettings: PageSettings | null
  warnings: string[]
}

export interface RejectedImport {
  ok: false
  message: string
}

export function interpretImportResponse(status: number, body: unknown): ImportedDocument | RejectedImport {
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') {
    return { ok: false, message: 'Import failed.' }
  }
  const record = body as Record<string, unknown>
  if (typeof record.html !== 'string') return { ok: false, message: 'Import failed.' }
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((item): item is string => typeof item === 'string')
    : []
  return {
    ok: true,
    html: record.html,
    pageSettings: parsePageSettings(record.page_settings),
    warnings,
  }
}

export async function requestDocxImport(file: File): Promise<ImportedDocument | RejectedImport> {
  const form = new FormData()
  form.append('file', file)
  try {
    const response = await apiFetch('/api/import', { method: 'POST', body: form })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return interpretImportResponse(response.status, body)
  } catch {
    return { ok: false, message: 'Import failed. Is the backend running?' }
  }
}
