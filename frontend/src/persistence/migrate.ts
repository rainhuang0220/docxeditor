import { getDocumentDb } from './db.ts'
import { loadCurrentDocument } from './documentStore.ts'
import { PersistenceError, wrapStorageError } from './errors.ts'
import {
  CURRENT_DOCUMENT_ID,
  DOCUMENT_SCHEMA_VERSION,
  LEGACY_DOCUMENT_KEY,
  LEGACY_VERSIONS_KEY,
  MAX_VERSIONS,
  type CurrentDocumentRecord,
  type VersionRecord,
} from './types.ts'
import { parseLegacyDocumentJson, parseLegacyVersionsJson } from './validate.ts'
import { countVersions, listVersions } from './versionStore.ts'

export type MigrationResult =
  | { status: 'skipped'; versionWarning?: string }
  | { status: 'noop' }
  | { status: 'migrated'; document: boolean; versions: number }
  | { status: 'failed'; reason: 'unavailable' | 'malformed' | 'write'; message: string }

function readLegacyRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function removeLegacyKey(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

function newestFirst(records: VersionRecord[]): VersionRecord[] {
  return [...records].sort((a, b) => {
    const byTime = b.timestamp.localeCompare(a.timestamp)
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
  })
}

async function writeBundle(
  document: CurrentDocumentRecord | null,
  versions: VersionRecord[],
): Promise<void> {
  const db = await getDocumentDb()
  const tx = db.transaction(['documents', 'versions'], 'readwrite')
  if (document) {
    await tx.objectStore('documents').put(document)
  }
  const versionStore = tx.objectStore('versions')
  for (const rec of versions) {
    await versionStore.put(rec)
  }
  await tx.done
}

async function verifyBundle(
  document: CurrentDocumentRecord | null,
  versions: VersionRecord[],
): Promise<boolean> {
  if (document) {
    const current = await loadCurrentDocument()
    if (
      current.status !== 'ok'
      || current.record.html !== document.html
      || current.record.savedAt !== document.savedAt
    ) {
      return false
    }
  }
  if (versions.length > 0) {
    const listed = await listVersions()
    for (const rec of versions) {
      const found = listed.find(item => item.id === rec.id)
      if (!found || found.content !== rec.content) return false
    }
  }
  return true
}

/**
 * One-time copy of legacy localStorage document/versions into IndexedDB.
 * Legacy keys are removed only after the corresponding durable records verify.
 * Preferences, threads, models, and API keys are never touched.
 */
export async function migrateLegacyPersistence(): Promise<MigrationResult> {
  let currentLoad: Awaited<ReturnType<typeof loadCurrentDocument>>
  try {
    currentLoad = await loadCurrentDocument()
  } catch (error) {
    const wrapped = wrapStorageError(error, 'unavailable')
    return { status: 'failed', reason: 'unavailable', message: wrapped.message }
  }

  const legacyDocRaw = readLegacyRaw(LEGACY_DOCUMENT_KEY)
  const legacyVerRaw = readLegacyRaw(LEGACY_VERSIONS_KEY)

  if (currentLoad.status === 'malformed') {
    return {
      status: 'failed',
      reason: 'malformed',
      message: 'Saved document is unreadable.',
    }
  }

  if (currentLoad.status === 'ok') {
    let versionWarning: string | undefined
    try {
      const versionCount = await countVersions()
      if (versionCount === 0 && legacyVerRaw) {
        const parsedVersions = parseLegacyVersionsJson(legacyVerRaw)
        if (parsedVersions === null) {
          versionWarning = 'Could not migrate version history.'
        } else if (parsedVersions.length > 0) {
          const kept = newestFirst(parsedVersions).slice(0, MAX_VERSIONS)
          await writeBundle(null, kept)
          if (await verifyBundle(null, kept)) {
            removeLegacyKey(LEGACY_VERSIONS_KEY)
          } else {
            versionWarning = 'Could not migrate version history.'
          }
        } else {
          removeLegacyKey(LEGACY_VERSIONS_KEY)
        }
      }
    } catch (error) {
      versionWarning = wrapStorageError(error, 'migration').message
    }
    const legacy = legacyDocRaw ? parseLegacyDocumentJson(legacyDocRaw) : null
    if (legacy && legacy.html === currentLoad.record.html) {
      removeLegacyKey(LEGACY_DOCUMENT_KEY)
    }
    return { status: 'skipped', versionWarning }
  }

  if (!legacyDocRaw && !legacyVerRaw) {
    return { status: 'noop' }
  }

  let document: CurrentDocumentRecord | null = null
  if (legacyDocRaw) {
    const parsed = parseLegacyDocumentJson(legacyDocRaw)
    if (!parsed) {
      return {
        status: 'failed',
        reason: 'malformed',
        message: 'Legacy saved document is unreadable.',
      }
    }
    document = {
      id: CURRENT_DOCUMENT_ID,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      html: parsed.html,
      savedAt: parsed.savedAt,
    }
  }

  let versions: VersionRecord[] = []
  let versionsParseFailed = false
  if (legacyVerRaw) {
    const parsed = parseLegacyVersionsJson(legacyVerRaw)
    if (parsed === null) {
      versionsParseFailed = true
    } else {
      versions = newestFirst(parsed).slice(0, MAX_VERSIONS)
    }
  }

  if (!document && versions.length === 0 && versionsParseFailed) {
    return {
      status: 'failed',
      reason: 'malformed',
      message: 'Legacy version history is unreadable.',
    }
  }

  try {
    await writeBundle(document, versions)
    if (!(await verifyBundle(document, versions))) {
      throw new PersistenceError('migration', 'Migrated document could not be verified.')
    }
  } catch (error) {
    const wrapped = wrapStorageError(error, 'migration')
    return { status: 'failed', reason: 'write', message: wrapped.message }
  }

  if (document) removeLegacyKey(LEGACY_DOCUMENT_KEY)
  if (!versionsParseFailed) removeLegacyKey(LEGACY_VERSIONS_KEY)

  return {
    status: 'migrated',
    document: Boolean(document),
    versions: versions.length,
  }
}

export function readLegacyDocumentForSession(): { html: string; savedAt: string } | null {
  const raw = readLegacyRaw(LEGACY_DOCUMENT_KEY)
  if (!raw) return null
  return parseLegacyDocumentJson(raw)
}
