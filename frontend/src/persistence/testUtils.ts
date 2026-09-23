import { IDBFactory } from 'fake-indexeddb'
import { closeDocumentDb } from './db.ts'
import { LEGACY_DOCUMENT_KEY, LEGACY_VERSIONS_KEY } from './types.ts'

export async function resetPersistence(): Promise<void> {
  await closeDocumentDb()
  const factory = new IDBFactory()
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true })
  try {
    localStorage.removeItem(LEGACY_DOCUMENT_KEY)
    localStorage.removeItem(LEGACY_VERSIONS_KEY)
  } catch {
    /* ignore */
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function createFakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { fn: () => void; at: number }>()
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
    async advance(ms: number) {
      now += ms
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now)
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.fn()
      }
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}
