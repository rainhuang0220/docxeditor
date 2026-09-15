import {
  isDocumentMutationLocked,
  lockDocumentMutations,
  unlockDocumentMutations,
} from '../ai/mutationLatch.ts'
import type {
  DestructiveChangeOutcome,
  SaveOutcome,
  VersionOutcome,
} from './types.ts'

export const RECOVERY_BLOCK_MESSAGE =
  'Could not save a recovery copy, so the document was not replaced.'

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

  lockDocumentMutations()
  const snapshot = deps.getSnapshot()
  const fail = (outcome: SaveOutcome | VersionOutcome): DestructiveChangeOutcome => {
    if (isDocumentMutationLocked()) unlockDocumentMutations()
    if (outcome.ok) {
      return { ok: false, kind: 'error', message: RECOVERY_BLOCK_MESSAGE }
    }
    return { ok: false, kind: outcome.kind, message: outcome.message }
  }

  try {
    const flushed = await deps.flushNow()
    if (!flushed.ok) return fail(flushed)

    const version = await deps.createVersion(description, snapshot)
    if (!version.ok) return fail(version)

    if (deps.getSnapshot() !== snapshot) {
      if (isDocumentMutationLocked()) unlockDocumentMutations()
      return { ok: false, kind: 'error', message: RECOVERY_BLOCK_MESSAGE }
    }

    const transition = await deps.beginDestructiveTransition()
    if (!transition.ok) return fail(transition)

    return {
      ok: true,
      savedAt: flushed.savedAt,
      version: version.version,
      applyReplacement: (fn: () => void) => {
        if (isDocumentMutationLocked()) unlockDocumentMutations()
        fn()
      },
    }
  } catch (error) {
    if (isDocumentMutationLocked()) unlockDocumentMutations()
    const message = error instanceof Error && error.message
      ? error.message
      : RECOVERY_BLOCK_MESSAGE
    return { ok: false, kind: 'error', message }
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


