import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { PersistenceError, wrapStorageError } from './errors.ts'
import {
  DB_NAME,
  DB_VERSION,
  type CurrentDocumentRecord,
  type VersionRecord,
} from './types.ts'

export interface DocxEditorDB extends DBSchema {
  documents: {
    key: string
    value: CurrentDocumentRecord
  }
  versions: {
    key: string
    value: VersionRecord
    indexes: { 'by-timestamp': string }
  }
}

let dbPromise: Promise<IDBPDatabase<DocxEditorDB>> | null = null

function assertIndexedDbAvailable() {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    throw new PersistenceError('unavailable', 'Document storage is unavailable.')
  }
}

export function getDocumentDb(): Promise<IDBPDatabase<DocxEditorDB>> {
  assertIndexedDbAvailable()
  if (!dbPromise) {
    dbPromise = openDB<DocxEditorDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('documents')) {
          database.createObjectStore('documents', { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains('versions')) {
          const versions = database.createObjectStore('versions', { keyPath: 'id' })
          versions.createIndex('by-timestamp', 'timestamp')
        }
      },
    }).catch((error: unknown) => {
      dbPromise = null
      throw wrapStorageError(error, 'unavailable')
    })
  }
  return dbPromise
}

export async function closeDocumentDb(): Promise<void> {
  if (!dbPromise) return
  const pending = dbPromise
  dbPromise = null
  try {
    const db = await pending
    db.close()
  } catch {
    /* ignore close of a failed open */
  }
}

export async function deleteDocumentDb(): Promise<void> {
  await closeDocumentDb()
  try {
    await deleteDB(DB_NAME, {
      blocked() {
        /* a leftover connection is already closed above */
      },
    })
  } catch (error) {
    throw wrapStorageError(error, 'unavailable')
  }
}
