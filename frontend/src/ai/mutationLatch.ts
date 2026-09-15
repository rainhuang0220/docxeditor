export const REPLACEMENT_BUSY_MESSAGE =
  'Another document replacement is already in progress.'

export interface ExclusiveLease {
  readonly id: string
  /** Idempotent. No-ops if this lease is not the current owner. */
  release(): void
}

let mutationOwner: string | null = null
let flightOwner: string | null = null

function acquire(slot: { get(): string | null; set(id: string | null): void }): ExclusiveLease | null {
  if (slot.get() !== null) return null
  const id = crypto.randomUUID()
  slot.set(id)
  let released = false
  return {
    id,
    release() {
      if (released) return
      released = true
      if (slot.get() === id) slot.set(null)
    },
  }
}

/** Exclusive ReviewLock lease while a destructive prepare is flushing/checkpointing. */
export function tryAcquireDocumentMutationLock(): ExclusiveLease | null {
  return acquire({
    get: () => mutationOwner,
    set: id => { mutationOwner = id },
  })
}

/** Exclusive single-flight for the whole replaceCurrentDocument operation. */
export function tryBeginDestructiveReplacement(): ExclusiveLease | null {
  return acquire({
    get: () => flightOwner,
    set: id => { flightOwner = id },
  })
}

export function isDocumentMutationLocked(): boolean {
  return mutationOwner !== null
}

export function isDestructiveReplacementInFlight(): boolean {
  return flightOwner !== null
}

export function resetDocumentMutationLatchForTests(): void {
  mutationOwner = null
  flightOwner = null
}
