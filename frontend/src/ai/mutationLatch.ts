let depth = 0

/** Blocks ordinary docChanged transactions via ReviewLock while a destructive prepare is in flight. */
export function lockDocumentMutations(): void {
  depth += 1
}

export function unlockDocumentMutations(): void {
  depth = Math.max(0, depth - 1)
}

export function isDocumentMutationLocked(): boolean {
  return depth > 0
}

export function resetDocumentMutationLatchForTests(): void {
  depth = 0
}
