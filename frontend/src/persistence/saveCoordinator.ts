import { PersistenceError, SkipPersistError } from './errors.ts'
import { AUTOSAVE_DEBOUNCE_MS, type PersistenceStatus, type SaveOutcome } from './types.ts'

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
  flushNow(): Promise<SaveOutcome>
  beginDestructiveTransition(): Promise<SaveOutcome>
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
  let inFlight: Promise<SaveOutcome> | null = null
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

  const outcomeFromError = (error: unknown): SaveOutcome => {
    if (error instanceof PersistenceError && error.code === 'unavailable') {
      setStatus({ kind: 'degraded', message: error.message })
      dirty = true
      return { ok: false, kind: 'degraded', message: error.message }
    }
    const message = error instanceof Error && error.message
      ? error.message
      : 'Could not save the document.'
    fail(message)
    return { ok: false, kind: 'error', message }
  }

  const runOnce = async (): Promise<SaveOutcome> => {
    if (disposed) {
      return { ok: false, kind: 'error', message: 'Could not save the document.' }
    }
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
        return { ok: false, kind: 'skipped', message: 'Cannot save while an AI proposal is pending.' }
      }
      return outcomeFromError(error)
    }

    if (lastHtml === html && lastAckedSeq > 0 && lastSavedAt) {
      if (!dirty) setStatus({ kind: 'clean', savedAt: lastSavedAt })
      return { ok: true, savedAt: lastSavedAt }
    }

    setStatus({ kind: 'saving' })
    try {
      const result = await options.persist(html, { seq: nextSeq, generation: gen })
      if (disposed) {
        return { ok: false, kind: 'error', message: 'Could not save the document.' }
      }
      if (generation !== gen) {
        dirty = true
        return { ok: false, kind: 'skipped', message: 'Save superseded.' }
      }
      if (nextSeq < lastAckedSeq) {
        return lastSavedAt
          ? { ok: true, savedAt: lastSavedAt }
          : { ok: false, kind: 'skipped', message: 'Save superseded.' }
      }
      lastAckedSeq = nextSeq
      lastHtml = html
      lastSavedAt = result.savedAt
      if (!dirty) setStatus({ kind: 'clean', savedAt: result.savedAt })
      return { ok: true, savedAt: result.savedAt }
    } catch (error) {
      if (generation !== gen) {
        dirty = true
        return { ok: false, kind: 'skipped', message: 'Save superseded.' }
      }
      return outcomeFromError(error)
    }
  }

  const drain = async (): Promise<SaveOutcome> => {
    let last: SaveOutcome = lastSavedAt && !dirty
      ? { ok: true, savedAt: lastSavedAt }
      : { ok: false, kind: 'skipped', message: 'Nothing to save.' }
    while (!disposed && (dirty || inFlight)) {
      if (inFlight) {
        last = await inFlight
        continue
      }
      if (!dirty) break
      const running = runOnce()
      inFlight = running
      try {
        last = await running
      } finally {
        if (inFlight === running) inFlight = null
      }
      if (status.kind === 'error' || status.kind === 'degraded') return last
    }
    if (status.kind === 'clean' && lastSavedAt) return { ok: true, savedAt: lastSavedAt }
    if (status.kind === 'degraded') {
      return { ok: false, kind: 'degraded', message: status.message }
    }
    if (status.kind === 'error') {
      return { ok: false, kind: 'error', message: status.message }
    }
    return last
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
      if (disposed) {
        return { ok: false, kind: 'error', message: 'Could not save the document.' }
      }
      if (status.kind === 'degraded') {
        return { ok: false, kind: 'degraded', message: status.message }
      }
      clearTimer()
      dirty = true
      return drain()
    },

    async beginDestructiveTransition() {
      if (disposed) {
        return { ok: false, kind: 'error', message: 'Could not save the document.' }
      }
      if (status.kind === 'degraded') {
        return { ok: false, kind: 'degraded', message: status.message }
      }
      clearTimer()
      let outcome: SaveOutcome
      if (dirty || inFlight) {
        dirty = true
        outcome = await drain()
      } else if (lastSavedAt) {
        outcome = { ok: true, savedAt: lastSavedAt }
      } else {
        dirty = true
        outcome = await drain()
      }
      if (!outcome.ok) return outcome
      generation += 1
      dirty = false
      lastHtml = null
      clearTimer()
      return outcome
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
