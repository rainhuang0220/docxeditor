import { getDocumentDb } from './db.ts'
import { PersistenceError, wrapStorageError } from './errors.ts'
import { MAX_VERSIONS, type VersionRecord } from './types.ts'
import { parseVersionRecord } from './validate.ts'

let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function newestFirst(a: VersionRecord, b: VersionRecord): number {
  const byTime = b.timestamp.localeCompare(a.timestamp)
  if (byTime !== 0) return byTime
  return b.id.localeCompare(a.id)
}

export async function listVersions(): Promise<VersionRecord[]> {
  try {
    const db = await getDocumentDb()
    const raw = await db.getAll('versions')
    const parsed: VersionRecord[] = []
    for (const item of raw) {
      const rec = parseVersionRecord(item)
      if (rec) parsed.push(rec)
    }
    parsed.sort(newestFirst)
    return parsed
  } catch (error) {
    throw wrapStorageError(error, 'unavailable')
  }
}

export async function createVersion(record: VersionRecord): Promise<VersionRecord> {
  return enqueue(async () => {
    const parsed = parseVersionRecord(record)
    if (!parsed) {
      throw new PersistenceError('version-write', 'Version save could not be verified.')
    }
    try {
      const db = await getDocumentDb()
      const tx = db.transaction('versions', 'readwrite')
      // Drop unreadable rows first so they cannot consume MAX_VERSIONS slots.
      let sweep = await tx.store.openCursor()
      while (sweep) {
        if (!parseVersionRecord(sweep.value)) {
          await sweep.delete()
        }
        sweep = await sweep.continue()
      }
      await tx.store.put(parsed)
      const raw = await tx.store.getAll()
      const parseable = raw
        .map(item => parseVersionRecord(item))
        .filter((item): item is VersionRecord => item !== null)
        .sort(newestFirst)
      for (const excess of parseable.slice(MAX_VERSIONS)) {
        await tx.store.delete(excess.id)
      }
      await tx.done
    } catch (error) {
      throw wrapStorageError(error, 'version-write')
    }
    const listed = await listVersions()
    const found = listed.find(item => item.id === parsed.id)
    if (!found) {
      try {
        const db = await getDocumentDb()
        await db.delete('versions', parsed.id)
      } catch {
        /* ignore cleanup failure */
      }
      throw new PersistenceError('version-write', 'Version save could not be verified.')
    }
    return found
  })
}

export async function deleteVersion(id: string): Promise<void> {
  return enqueue(async () => {
    try {
      const db = await getDocumentDb()
      await db.delete('versions', id)
    } catch (error) {
      throw wrapStorageError(error, 'version-write')
    }
  })
}

export async function countVersions(): Promise<number> {
  try {
    const db = await getDocumentDb()
    return await db.count('versions')
  } catch (error) {
    throw wrapStorageError(error, 'unavailable')
  }
}

export async function replaceAllVersions(records: VersionRecord[]): Promise<void> {
  return enqueue(async () => {
    try {
      const db = await getDocumentDb()
      const tx = db.transaction('versions', 'readwrite')
      let cursor = await tx.store.openCursor()
      while (cursor) {
        await cursor.delete()
        cursor = await cursor.continue()
      }
      const kept = [...records].sort(newestFirst).slice(0, MAX_VERSIONS)
      for (const rec of kept) {
        await tx.store.put(rec)
      }
      await tx.done
    } catch (error) {
      throw wrapStorageError(error, 'version-write')
    }
  })
}
