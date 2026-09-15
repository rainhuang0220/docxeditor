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
  type HydrationResult,
  type LoadCurrentResult,
  type PersistenceStatus,
  type VersionRecord,
} from './types.ts'
export { PersistenceError, SkipPersistError } from './errors.ts'
export { getDocumentDb, closeDocumentDb, deleteDocumentDb } from './db.ts'
export { loadCurrentDocument, saveCurrentDocument } from './documentStore.ts'
export { listVersions, createVersion, deleteVersion, countVersions } from './versionStore.ts'
export { migrateLegacyPersistence, readLegacyDocumentForSession } from './migrate.ts'
export { createSaveCoordinator, type SaveCoordinator } from './saveCoordinator.ts'
export { hydrateDocument, resolveInitialHtml, DEFAULT_DOCUMENT_HTML } from './hydrate.ts'
export { formatPersistenceStatus, persistenceStatusIsSaved } from './status.ts'
export { bindPageLifecycle, isDocumentHidden } from './lifecycle.ts'
