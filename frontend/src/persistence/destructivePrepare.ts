import {
  REPLACEMENT_BUSY_MESSAGE,
  tryAcquireDocumentMutationLock,
  tryBeginDestructiveReplacement,
} from '../ai/mutationLatch.ts'
import type {
  DestructiveChangeOutcome,
  ReplaceDocumentOutcome,
  SaveOutcome,
  VersionOutcome,
} from './types.ts'

export const RECOVERY_BLOCK_MESSAGE =
  'Could not save a recovery copy, so the document was not replaced.'

export { REPLACEMENT_BUSY_MESSAGE }

export interface DestructivePrepareDeps {
  persistEnabled: boolean
  storageUnavailable: boolean
  getSnapshot: () => string
  flushNow: () => Promise<SaveOutcome>
  createVersion: (description: string, html: string) => Promise<VersionOutcome>
  beginDestructiveTransition: () => Promise<SaveOutcome>
}

export async function prepareDestructiveDocumentChange(
  description: string,
  deps: DestructivePrepareDeps,
): Promise<DestructiveChangeOutcome> {
  if (!deps.persistEnabled || deps.storageUnavailable) {
    return { ok: false, kind: 'degraded', message: 'Document storage is unavailable.' }
  }

  const lock = tryAcquireDocumentMutationLock()
  if (!lock) {
    return { ok: false, kind: 'skipped', message: REPLACEMENT_BUSY_MESSAGE }
  }

  try {
    const snapshot = deps.getSnapshot()
    const flushed = await deps.flushNow()
    if (!flushed.ok) {
      return { ok: false, kind: flushed.kind, message: flushed.message }
    }

    const version = await deps.createVersion(description, snapshot)
    if (!version.ok) {
      return { ok: false, kind: version.kind, message: version.message }
    }

    if (deps.getSnapshot() !== snapshot) {
      return { ok: false, kind: 'error', message: RECOVERY_BLOCK_MESSAGE }
    }

    const transition = await deps.beginDestructiveTransition()
    if (!transition.ok) {
      return { ok: false, kind: transition.kind, message: transition.message }
    }

    return {
      ok: true,
      savedAt: flushed.savedAt,
      version: version.version,
      applyReplacement: (fn: () => void) => {
        fn()
      },
    }
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : RECOVERY_BLOCK_MESSAGE
    return { ok: false, kind: 'error', message }
  } finally {
    lock.release()
  }
}

export async function runDestructiveReplacement(input: {
  nextHtml: string
  description: string
  apply: (html: string) => boolean
  flushAfter?: () => Promise<SaveOutcome>
} & DestructivePrepareDeps): Promise<ReplaceDocumentOutcome> {
  const flight = tryBeginDestructiveReplacement()
  if (!flight) {
    return { ok: false, replaced: false, kind: 'skipped', message: REPLACEMENT_BUSY_MESSAGE }
  }
  try {
    const prep = await prepareDestructiveDocumentChange(input.description, input)
    if (!prep.ok) {
      return { ok: false, replaced: false, kind: prep.kind, message: prep.message }
    }
    let applied = false
    try {
      applied = input.apply(input.nextHtml)
    } catch {
      return { ok: false, replaced: false, kind: 'error', message: RECOVERY_BLOCK_MESSAGE }
    }
    if (!applied) {
      return { ok: false, replaced: false, kind: 'error', message: RECOVERY_BLOCK_MESSAGE }
    }
    if (!input.flushAfter) {
      return { ok: true, replaced: true, savedAt: prep.savedAt }
    }
    const after = await input.flushAfter()
    if (!after.ok) {
      return { ok: false, replaced: true, kind: after.kind, message: after.message }
    }
    return { ok: true, replaced: true, savedAt: after.savedAt }
  } finally {
    flight.release()
  }
}

export async function saveManualVersion(
  flushNow: () => Promise<SaveOutcome>,
  createVersion: (description: string) => Promise<VersionOutcome>,
): Promise<SaveOutcome> {
  const flushed = await flushNow()
  if (!flushed.ok) return flushed
  const version = await createVersion('Manual save')
  if (!version.ok) return version
  return flushed
}

export async function persistAfterAccept(
  flushNow: () => Promise<SaveOutcome>,
  createVersion: (description: string) => Promise<VersionOutcome>,
): Promise<SaveOutcome> {
  const flushed = await flushNow()
  if (!flushed.ok) return flushed
  await createVersion('AI edit accepted')
  return flushed
}

export async function persistAfterReject(
  flushNow: () => Promise<SaveOutcome>,
): Promise<SaveOutcome> {
  return flushNow()
}


