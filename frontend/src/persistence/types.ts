export const DB_NAME = 'docxeditor'
export const DB_VERSION = 1
export const CURRENT_DOCUMENT_ID = 'current'
export const DOCUMENT_SCHEMA_VERSION = 1
export const MAX_VERSIONS = 20
/** Trailing debounce for ordinary typing. Flush paths do not wait for this. */
export const AUTOSAVE_DEBOUNCE_MS = 800

export const LEGACY_DOCUMENT_KEY = 'ai-doc-ide-document'
export const LEGACY_VERSIONS_KEY = 'ai-doc-ide-versions'

export interface PageSettingsRecord {
  widthTwip: number
  heightTwip: number
  marginTopTwip: number
  marginRightTwip: number
  marginBottomTwip: number
  marginLeftTwip: number
}

export interface CurrentDocumentRecord {
  id: typeof CURRENT_DOCUMENT_ID
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION
  html: string
  savedAt: string
  /** Absent on records saved before page setup was stored. */
  pageSettings?: PageSettingsRecord
}

export interface VersionRecord {
  id: string
  timestamp: string
  description: string
  content: string
}

export type PersistenceStatus =
  | { kind: 'loading' }
  | { kind: 'clean'; savedAt: string }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'degraded'; message: string }

export type HydrationResult =
  | { phase: 'loading' }
  | {
      phase: 'ready'
      html: string | null
      savedAt: string | null
      persistEnabled: boolean
      degraded: boolean
      message: string | null
      /** Distinct from save status: current document may still be writable. */
      migrationWarning?: string | null
      pageSettings?: PageSettingsRecord | null
    }
  | {
      phase: 'blocked'
      html: null
      savedAt: null
      persistEnabled: false
      degraded: true
      message: string
    }

export type LoadCurrentResult =
  | { status: 'ok'; record: CurrentDocumentRecord }
  | { status: 'missing' }
  | { status: 'malformed' }

export type PersistFailureKind = 'error' | 'degraded' | 'skipped'

export type SaveOutcome =
  | { ok: true; savedAt: string }
  | { ok: false; kind: PersistFailureKind; message: string }

export type VersionOutcome =
  | { ok: true; version: VersionRecord }
  | { ok: false; kind: PersistFailureKind; message: string }

export type DestructiveChangeOutcome =
  | {
      ok: true
      savedAt: string
      version: VersionRecord
      applyReplacement: (fn: () => void) => void
    }
  | { ok: false; kind: PersistFailureKind; message: string }

export type ReplaceDocumentOutcome =
  | { ok: true; replaced: true; savedAt: string }
  | { ok: false; replaced: false; kind: PersistFailureKind; message: string }
  | { ok: false; replaced: true; kind: PersistFailureKind; message: string }
