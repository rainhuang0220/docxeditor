import { getDocumentDb } from './db.ts'
import { PersistenceError, wrapStorageError } from './errors.ts'
import {
  CURRENT_DOCUMENT_ID,
  DOCUMENT_SCHEMA_VERSION,
  type CurrentDocumentRecord,
  type LoadCurrentResult,
  type PageSettingsRecord,
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

function samePageSettings(left?: PageSettingsRecord | null, right?: PageSettingsRecord | null): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return left.widthTwip === right.widthTwip
    && left.heightTwip === right.heightTwip
    && left.marginTopTwip === right.marginTopTwip
    && left.marginRightTwip === right.marginRightTwip
    && left.marginBottomTwip === right.marginBottomTwip
    && left.marginLeftTwip === right.marginLeftTwip
}

export async function saveCurrentDocument(
  html: string,
  savedAt: string = new Date().toISOString(),
  pageSettings?: PageSettingsRecord | null,
): Promise<CurrentDocumentRecord> {
  let stored = pageSettings
  if (stored === undefined) {
    const existing = await loadCurrentDocument()
    stored = existing.status === 'ok' ? existing.record.pageSettings : undefined
  }
  const record: CurrentDocumentRecord = {
    id: CURRENT_DOCUMENT_ID,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    html,
    savedAt,
    ...(stored ? { pageSettings: stored } : {}),
  }
  try {
    const db = await getDocumentDb()
    await db.put('documents', record)
  } catch (error) {
    throw wrapStorageError(error, 'write')
  }
  const readback = await loadCurrentDocument()
  const savedSettings = readback.status === 'ok' ? readback.record.pageSettings : undefined
  if (
    readback.status !== 'ok'
    || readback.record.html !== html
    || readback.record.savedAt !== savedAt
    || !samePageSettings(savedSettings, stored)
  ) {
    throw new PersistenceError('write', 'Document save could not be verified.')
  }
  return record
}
