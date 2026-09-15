export {
  AUTOSAVE_DEBOUNCE_MS,
  CURRENT_DOCUMENT_ID,
  DB_NAME,
  DB_VERSION,
  DOCUMENT_SCHEMA_VERSION,
  LEGACY_DOCUMENT_KEY,
  LEGACY_VERSIONS_KEY,
  MAX_VERSIONS,
  type CurrentDocumentRecord,
  type DestructiveChangeOutcome,
  type HydrationResult,
  type LoadCurrentResult,
  type PersistFailureKind,
  type PersistenceStatus,
  type ReplaceDocumentOutcome,
  type SaveOutcome,
  type VersionOutcome,
  type VersionRecord,
} from './types.ts'
export { PersistenceError, SkipPersistError } from './errors.ts'
export { getDocumentDb, closeDocumentDb, deleteDocumentDb } from './db.ts'
export { loadCurrentDocument, saveCurrentDocument } from './documentStore.ts'
export { listVersions, createVersion, deleteVersion, countVersions } from './versionStore.ts'
export { migrateLegacyPersistence, readLegacyDocumentForSession } from './migrate.ts'
export { createSaveCoordinator, type SaveCoordinator } from './saveCoordinator.ts'
export {
  prepareDestructiveDocumentChange,
  persistAfterAccept,
  persistAfterReject,
  RECOVERY_BLOCK_MESSAGE,
  REPLACEMENT_BUSY_MESSAGE,
  runDestructiveReplacement,
  saveManualVersion,
} from './destructivePrepare.ts'
export { applyVerifiedReplacement } from './editorReplacement.ts'
export { hydrateDocument, resolveInitialHtml, DEFAULT_DOCUMENT_HTML } from './hydrate.ts'
export { formatPersistenceStatus, persistenceStatusIsSaved } from './status.ts'
export { bindPageLifecycle, isDocumentHidden } from './lifecycle.ts'
