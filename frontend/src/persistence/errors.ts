export type PersistenceFailureCode =
  | 'unavailable'
  | 'write'
  | 'malformed'
  | 'migration'
  | 'version-write'

export class PersistenceError extends Error {
  readonly code: PersistenceFailureCode

  constructor(code: PersistenceFailureCode, message: string) {
    super(message)
    this.name = 'PersistenceError'
    this.code = code
  }
}

/** Coordinator should skip this write rather than persist live/proposal HTML. */
export class SkipPersistError extends Error {
  constructor() {
    super('skip-persist')
    this.name = 'SkipPersistError'
  }
}

export function wrapStorageError(
  error: unknown,
  code: 'write' | 'version-write' | 'unavailable' | 'migration' = 'write',
): PersistenceError {
  if (error instanceof PersistenceError) return error
  const name = error instanceof Error ? error.name : ''
  if (
    name === 'InvalidStateError'
    || name === 'UnknownError'
    || name === 'SecurityError'
    || name === 'NotFoundError'
  ) {
    return new PersistenceError('unavailable', 'Document storage is unavailable.')
  }
  if (name === 'QuotaExceededError') {
    const message = code === 'version-write'
      ? 'Version storage is full.'
      : 'Document storage is full.'
    return new PersistenceError(code, message)
  }
  if (code === 'unavailable') {
    return new PersistenceError('unavailable', 'Document storage is unavailable.')
  }
  if (code === 'version-write') {
    return new PersistenceError('version-write', 'Could not save a version.')
  }
  if (code === 'migration') {
    return new PersistenceError('migration', 'Could not migrate the saved document.')
  }
  return new PersistenceError('write', 'Could not save the document.')
}
