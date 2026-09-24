import { loadCurrentDocument } from './documentStore.ts'
import { wrapStorageError } from './errors.ts'
import { migrateLegacyPersistence, readLegacyDocumentForSession } from './migrate.ts'
import type { HydrationResult } from './types.ts'

export const DEFAULT_DOCUMENT_HTML = `
      <h1 style="text-align: center">Untitled Document</h1>
      <p style="text-align: center"><em>Created with AI Document IDE</em></p>
      <p></p>
      <h2>Introduction</h2>
      <p>Start writing here, or ask the AI assistant to help you create content.</p>
      <p></p>
    `

/**
 * Resolve the HTML that may be handed to TipTap. `null` means the editor
 * must not mount yet (loading) or must not mount with default content
 * (blocked / malformed durable record).
 */
export function resolveInitialHtml(
  hydration: HydrationResult,
  defaultContent: string = DEFAULT_DOCUMENT_HTML,
): string | null {
  if (hydration.phase === 'loading' || hydration.phase === 'blocked') return null
  if (hydration.html !== null) return hydration.html
  return defaultContent
}

export async function hydrateDocument(): Promise<HydrationResult> {
  let migration
  try {
    migration = await migrateLegacyPersistence()
  } catch (error) {
    const wrapped = wrapStorageError(error, 'unavailable')
    const legacy = readLegacyDocumentForSession()
    return {
      phase: 'ready',
      html: legacy?.html ?? null,
      savedAt: legacy?.savedAt ?? null,
      persistEnabled: false,
      degraded: true,
      message: wrapped.message,
      migrationWarning: null,
    }
  }

  if (migration.status === 'failed' && migration.reason === 'unavailable') {
    const legacy = readLegacyDocumentForSession()
    return {
      phase: 'ready',
      html: legacy?.html ?? null,
      savedAt: legacy?.savedAt ?? null,
      persistEnabled: false,
      degraded: true,
      message: migration.message,
      migrationWarning: null,
    }
  }

  if (migration.status === 'failed' && migration.reason === 'malformed') {
    const current = await loadCurrentDocument().catch(() => ({ status: 'missing' as const }))
    if (current.status === 'malformed') {
      return {
        phase: 'blocked',
        html: null,
        savedAt: null,
        persistEnabled: false,
        degraded: true,
        message: migration.message,
      }
    }
    const legacy = readLegacyDocumentForSession()
    if (legacy) {
      return {
        phase: 'ready',
        html: legacy.html,
        savedAt: legacy.savedAt,
        persistEnabled: false,
        degraded: true,
        message: migration.message,
      }
    }
    if (current.status === 'ok') {
      return {
        phase: 'ready',
        html: current.record.html,
        savedAt: current.record.savedAt,
        persistEnabled: true,
        degraded: false,
        message: null,
        migrationWarning: migration.message,
        pageSettings: current.record.pageSettings ?? null,
      }
    }
    return {
      phase: 'ready',
      html: null,
      savedAt: null,
      persistEnabled: true,
      degraded: true,
      message: migration.message,
      migrationWarning: migration.message,
    }
  }

  if (migration.status === 'failed') {
    const legacy = readLegacyDocumentForSession()
    const current = await loadCurrentDocument().catch(() => ({ status: 'missing' as const }))
    const html = current.status === 'ok' ? current.record.html : (legacy?.html ?? null)
    const savedAt = current.status === 'ok' ? current.record.savedAt : (legacy?.savedAt ?? null)
    const currentOk = current.status === 'ok'
    return {
      phase: 'ready',
      html,
      savedAt,
      persistEnabled: currentOk,
      degraded: !currentOk,
      message: currentOk ? null : migration.message,
      migrationWarning: migration.message,
    }
  }

  try {
    const current = await loadCurrentDocument()
    if (current.status === 'malformed') {
      return {
        phase: 'blocked',
        html: null,
        savedAt: null,
        persistEnabled: false,
        degraded: true,
        message: 'Saved document is unreadable.',
      }
    }
    const warning = migration.status === 'skipped' ? (migration.versionWarning ?? null) : null
    if (current.status === 'missing') {
      return {
        phase: 'ready',
        html: null,
        savedAt: null,
        persistEnabled: true,
        degraded: false,
        message: null,
        migrationWarning: warning,
      }
    }
    return {
      phase: 'ready',
      html: current.record.html,
      savedAt: current.record.savedAt,
      persistEnabled: true,
      degraded: false,
      message: null,
      migrationWarning: warning,
      pageSettings: current.record.pageSettings ?? null,
    }
  } catch (error) {
    const wrapped = wrapStorageError(error, 'unavailable')
    const legacy = readLegacyDocumentForSession()
    return {
      phase: 'ready',
      html: legacy?.html ?? null,
      savedAt: legacy?.savedAt ?? null,
      persistEnabled: false,
      degraded: true,
      message: wrapped.message,
      migrationWarning: null,
    }
  }
}
