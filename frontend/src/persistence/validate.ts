import {
  CURRENT_DOCUMENT_ID,
  DOCUMENT_SCHEMA_VERSION,
  type CurrentDocumentRecord,
  type VersionRecord,
} from './types.ts'

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

export function parseCurrentDocument(input: unknown): CurrentDocumentRecord | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  if (rec.id !== CURRENT_DOCUMENT_ID) return null
  if (rec.schemaVersion !== DOCUMENT_SCHEMA_VERSION) return null
  if (typeof rec.html !== 'string') return null
  if (!isIsoTimestamp(rec.savedAt)) return null
  return {
    id: CURRENT_DOCUMENT_ID,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    html: rec.html,
    savedAt: rec.savedAt,
  }
}

export function parseVersionRecord(input: unknown): VersionRecord | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id.length === 0) return null
  if (!isIsoTimestamp(rec.timestamp)) return null
  if (typeof rec.description !== 'string') return null
  if (typeof rec.content !== 'string') return null
  return {
    id: rec.id,
    timestamp: rec.timestamp,
    description: rec.description,
    content: rec.content,
  }
}

export function parseLegacyDocumentJson(raw: string): { html: string; savedAt: string } | null {
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object') return null
    const rec = data as Record<string, unknown>
    if (typeof rec.html !== 'string') return null
    const savedAt = isIsoTimestamp(rec.savedAt) ? rec.savedAt : new Date().toISOString()
    return { html: rec.html, savedAt }
  } catch {
    return null
  }
}

export function parseLegacyVersionsJson(raw: string): VersionRecord[] | null {
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return null
    const out: VersionRecord[] = []
    for (const item of data) {
      const parsed = parseVersionRecord(item)
      if (parsed) out.push(parsed)
    }
    return out
  } catch {
    return null
  }
}
