import { SkipPersistError } from './errors.ts'
import { AUTOSAVE_DEBOUNCE_MS, type PersistenceStatus } from './types.ts'

export interface PersistMeta {
  seq: number
  generation: number
}

export interface PersistResult {
  savedAt: string
}

export interface CoordinatorClock {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

export interface SaveCoordinatorOptions {
  getSnapshot: () => string
  persist: (html: string, meta: PersistMeta) => Promise<PersistResult>
  onStatus?: (status: PersistenceStatus) => void
  debounceMs?: number
  clock?: CoordinatorClock
}

export interface SaveCoordinator {
  scheduleSave(): void
  flushNow(): Promise<void>
  beginDestructiveTransition(): Promise<void>
  markClean(savedAt: string, html?: string): void
  markDegraded(message: string): void
  getStatus(): PersistenceStatus
  getGeneration(): number
  dispose(): void
}

const defaultClock: CoordinatorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
}

export function createSaveCoordinator(options: SaveCoordinatorOptions): SaveCoordinator {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS
  const clock = options.clock ?? defaultClock

  let generation = 1
  let seq = 0
  let lastAckedSeq = 0
  let dirty = false
  let disposed = false
  let inFlight: Promise<void> | null = null
  let timer: number | null = null
  let lastHtml: string | null = null
  let lastSavedAt: string | null = null
  let status: PersistenceStatus = { kind: 'dirty' }

  const setStatus = (next: PersistenceStatus) => {
    status = next
    options.onStatus?.(next)
  }

  const clearTimer = () => {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  const fail = (message: string) => {
    dirty = true
    setStatus({ kind: 'error', message })
  }

  const runOnce = async () => {
    if (disposed) return
    dirty = false
    const gen = generation
    const nextSeq = ++seq
    let html: string
    try {
      html = options.getSnapshot()
    } catch (error) {
      if (error instanceof SkipPersistError) {
        if (status.kind !== 'error' && status.kind !== 'degraded') {
          setStatus({ kind: 'dirty' })
        }
        return
      }
      const message = error instanceof Error && error.message
        ? 'Could not save the document.'
        : 'Could not save the document.'
      fail(message)
      dirty = true
      return
    }

    if (lastHtml === html && lastAckedSeq > 0 && lastSavedAt) {
      if (!dirty) setStatus({ kind: 'clean', savedAt: lastSavedAt })
      return
    }

    setStatus({ kind: 'saving' })
    try {
      const result = await options.persist(html, { seq: nextSeq, generation: gen })
      if (disposed) return
      if (generation !== gen) {
        dirty = true
        return
      }
      if (nextSeq < lastAckedSeq) return
      lastAckedSeq = nextSeq
      lastHtml = html
      lastSavedAt = result.savedAt
      if (!dirty) setStatus({ kind: 'clean', savedAt: result.savedAt })
    } catch (error) {
      if (generation !== gen) {
        dirty = true
        return
      }
      const message = error instanceof Error && error.message
        ? error.message
        : 'Could not save the document.'
      fail(message)
    }
  }

  const drain = async () => {
    while (!disposed && (dirty || inFlight)) {
      if (inFlight) {
        await inFlight
        continue
      }
      if (!dirty) return
      const running = runOnce()
      inFlight = running
      try {
        await running
      } finally {
        if (inFlight === running) inFlight = null
      }
      // A failed write stays dirty/unsaved, but must not spin forever.
      if (status.kind === 'error' || status.kind === 'degraded') return
    }
  }

  return {
    scheduleSave() {
      if (disposed) return
      dirty = true
      if (status.kind !== 'saving' && status.kind !== 'error' && status.kind !== 'degraded') {
        setStatus({ kind: 'dirty' })
      }
      if (timer !== null) return
      timer = clock.setTimeout(() => {
        timer = null
        void drain()
      }, debounceMs)
    },

    async flushNow() {
      if (disposed) return
      clearTimer()
      dirty = true
      await drain()
    },

    async beginDestructiveTransition() {
      if (disposed) return
      clearTimer()
      if (dirty || inFlight) {
        await drain()
      }
      generation += 1
      dirty = false
      lastHtml = null
      clearTimer()
    },

    markClean(savedAt, html) {
      dirty = false
      lastSavedAt = savedAt
      if (html !== undefined) lastHtml = html
      lastAckedSeq = Math.max(lastAckedSeq, 1)
      setStatus({ kind: 'clean', savedAt })
    },

    markDegraded(message) {
      dirty = false
      clearTimer()
      setStatus({ kind: 'degraded', message })
    },

    getStatus() {
      return status
    },

    getGeneration() {
      return generation
    },

    dispose() {
      disposed = true
      clearTimer()
    },
  }
}
