import { getDocumentDb } from './db.ts'
import { PersistenceError, wrapStorageError } from './errors.ts'
import {
  CURRENT_DOCUMENT_ID,
  DOCUMENT_SCHEMA_VERSION,
  type CurrentDocumentRecord,
  type LoadCurrentResult,
} from './types.ts'
import { parseCurrentDocument } from './validate.ts'

export async function loadCurrentDocument(): Promise<LoadCurrentResult> {
  try {
    const db = await getDocumentDb()
    const raw = await db.get('documents', CURRENT_DOCUMENT_ID)
    if (raw === undefined) return { status: 'missing' }
    const parsed = parseCurrentDocument(raw)
    if (!parsed) return { status: 'malformed' }
    return { status: 'ok', record: parsed }
  } catch (error) {
    throw wrapStorageError(error, 'unavailable')
  }
}

export async function saveCurrentDocument(
  html: string,
  savedAt: string = new Date().toISOString(),
): Promise<CurrentDocumentRecord> {
  const record: CurrentDocumentRecord = {
    id: CURRENT_DOCUMENT_ID,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    html,
    savedAt,
  }
  try {
    const db = await getDocumentDb()
    await db.put('documents', record)
  } catch (error) {
    throw wrapStorageError(error, 'write')
  }
  const readback = await loadCurrentDocument()
  if (readback.status !== 'ok' || readback.record.html !== html || readback.record.savedAt !== savedAt) {
    throw new PersistenceError('write', 'Document save could not be verified.')
  }
  return record
}
