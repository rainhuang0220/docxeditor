/** Map supervisor phase + elapsed wait into status-bar copy. */

export type BackendPhase =
  | 'starting'
  | 'authenticating'
  | 'ready'
  | 'unavailable'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | string

export type BackendReadinessTone = 'progress' | 'ready' | 'failed' | 'unknown'

export type BackendReadinessView = {
  label: string
  tone: BackendReadinessTone
  /** Click starts backend_retry. */
  canRetry: boolean
  title: string
}

/** After this many ms in starting/authenticating, copy becomes "Still starting…". */
export const STILL_STARTING_AFTER_MS = 8_000

export function backendReadinessView(
  phase: BackendPhase | null | undefined,
  elapsedMs: number,
  healthOk: boolean | null,
): BackendReadinessView {
  if (healthOk === true || phase === 'ready') {
    return {
      label: 'AI Ready',
      tone: 'ready',
      canRetry: false,
      title: 'Backend connected',
    }
  }

  if (phase === 'starting' || phase === 'authenticating') {
    const still = elapsedMs >= STILL_STARTING_AFTER_MS
    return {
      label: still ? 'Still starting…' : 'Starting…',
      tone: 'progress',
      canRetry: false,
      title: still
        ? 'Backend is still starting. This can take up to about a minute on first launch.'
        : 'Backend is starting.',
    }
  }

  if (phase === 'failed' || phase === 'unavailable' || phase === 'stopped' || phase === 'stopping') {
    return {
      label: 'Offline',
      tone: 'failed',
      canRetry: true,
      title: 'Backend offline. Retry starts a new backend.',
    }
  }

  // Browser/dev or status not yet known: avoid flashing Offline while we probe.
  if (phase == null && healthOk == null) {
    return {
      label: 'Starting…',
      tone: 'progress',
      canRetry: false,
      title: 'Checking backend…',
    }
  }

  if (healthOk === false) {
    return {
      label: 'Offline',
      tone: 'failed',
      canRetry: true,
      title: 'Backend offline. Retry starts a new backend.',
    }
  }

  return {
    label: 'Starting…',
    tone: 'progress',
    canRetry: false,
    title: 'Checking backend…',
  }
}
