import type { PersistenceStatus } from './types.ts'

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** StatusBar copy. Error/degraded never render as Saved. */
export function formatPersistenceStatus(status: PersistenceStatus): string {
  switch (status.kind) {
    case 'loading':
      return 'Loading…'
    case 'saving':
      return 'Saving…'
    case 'clean': {
      const time = formatSavedAt(status.savedAt)
      return time ? `Saved ${time}` : 'Saved'
    }
    case 'dirty':
      return 'Unsaved'
    case 'error':
      return 'Save failed'
    case 'degraded':
      return 'Save unavailable'
  }
}

export function persistenceStatusIsSaved(status: PersistenceStatus): boolean {
  return status.kind === 'clean'
}
