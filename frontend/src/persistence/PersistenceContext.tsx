import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useEditorContext } from '../context/EditorContext'
import { showToast } from '../components/Toast'
import { saveCurrentDocument } from './documentStore.ts'
import { PersistenceError, SkipPersistError } from './errors.ts'
import { hydrateDocument } from './hydrate.ts'
import { bindPageLifecycle } from './lifecycle.ts'
import { createSaveCoordinator, type SaveCoordinator } from './saveCoordinator.ts'
import {
  prepareDestructiveDocumentChange,
  persistAfterAccept,
  persistAfterReject,
  RECOVERY_BLOCK_MESSAGE,
  saveManualVersion,
} from './destructivePrepare.ts'
import {
  AUTOSAVE_DEBOUNCE_MS,
  type HydrationResult,
  type PersistenceStatus,
  type ReplaceDocumentOutcome,
  type SaveOutcome,
  type VersionOutcome,
  type VersionRecord,
} from './types.ts'
import { createVersion as persistVersion, deleteVersion as persistDeleteVersion, listVersions } from './versionStore.ts'

export interface PersistenceApi {
  hydration: HydrationResult
  status: PersistenceStatus
  persistEnabled: boolean
  scheduleSave: () => void
  flushNow: () => Promise<SaveOutcome>
  createVersion: (description: string, opts?: { html?: string; notify?: boolean }) => Promise<VersionOutcome>
  replaceCurrentDocument: (nextHtml: string, description: string) => Promise<ReplaceDocumentOutcome>
  saveManualVersion: () => Promise<SaveOutcome>
  persistAfterAccept: () => Promise<SaveOutcome>
  persistAfterReject: () => Promise<SaveOutcome>
  deleteVersion: (id: string) => Promise<void>
  versions: VersionRecord[]
  versionsError: string | null
  versionsBusy: boolean
  refreshVersions: () => Promise<void>
  startNewDocumentFromBlocked: () => void
}

const PersistenceContext = createContext<PersistenceApi | null>(null)

function persistEnabledOf(hydration: HydrationResult): boolean {
  if (hydration.phase === 'ready') return hydration.persistEnabled
  return false
}

export function PersistenceProvider({ children }: { children: ReactNode }) {
  const {
    editor,
    getPersistableDocumentHtml,
    canPersistCommittedDocumentNow,
  } = useEditorContext()

  const getPersistableRef = useRef(getPersistableDocumentHtml)
  getPersistableRef.current = getPersistableDocumentHtml
  const canPersistRef = useRef(canPersistCommittedDocumentNow)
  canPersistRef.current = canPersistCommittedDocumentNow

  const [hydration, setHydration] = useState<HydrationResult>({ phase: 'loading' })
  const [status, setStatus] = useState<PersistenceStatus>({ kind: 'loading' })
  const [versions, setVersions] = useState<VersionRecord[]>([])
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [versionsBusy, setVersionsBusy] = useState(false)
  const coordinatorRef = useRef<SaveCoordinator | null>(null)
  const persistEnabledRef = useRef(false)
  const errorToastedRef = useRef(false)
  const versionErrorToastedRef = useRef(false)

  persistEnabledRef.current = persistEnabledOf(hydration)

  const refreshVersions = useCallback(async () => {
    if (!persistEnabledRef.current) return
    setVersionsBusy(true)
    try {
      const listed = await listVersions()
      setVersions(listed)
      setVersionsError(null)
    } catch (error) {
      const message = error instanceof PersistenceError
        ? error.message
        : 'Could not load version history.'
      setVersionsError(message)
    } finally {
      setVersionsBusy(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await hydrateDocument()
      if (cancelled) return
      setHydration(result)
      if (result.phase === 'ready' && result.migrationWarning) {
        showToast(result.migrationWarning, 'info')
      }
      if (result.phase === 'ready' && result.persistEnabled && result.savedAt && result.html !== null) {
        coordinatorRef.current?.markClean(result.savedAt, result.html)
        setStatus({ kind: 'clean', savedAt: result.savedAt })
      } else if (result.phase === 'ready' && !result.persistEnabled) {
        coordinatorRef.current?.markDegraded(result.message || 'Document storage is unavailable.')
        setStatus({ kind: 'degraded', message: result.message || 'Document storage is unavailable.' })
      } else if (result.phase === 'blocked') {
        setStatus({ kind: 'error', message: result.message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (hydration.phase === 'loading') return
    if (hydration.phase === 'ready' && hydration.persistEnabled) {
      void refreshVersions()
    }
  }, [hydration, refreshVersions])

  useEffect(() => {
    const coordinator = createSaveCoordinator({
      debounceMs: AUTOSAVE_DEBOUNCE_MS,
      getSnapshot: () => {
        if (!persistEnabledRef.current) {
          throw new PersistenceError('unavailable', 'Document storage is unavailable.')
        }
        if (!canPersistRef.current()) {
          throw new SkipPersistError()
        }
        return getPersistableRef.current()
      },
      persist: async (html) => {
        if (!persistEnabledRef.current) {
          throw new PersistenceError('unavailable', 'Document storage is unavailable.')
        }
        const savedAt = new Date().toISOString()
        await saveCurrentDocument(html, savedAt)
        return { savedAt }
      },
      onStatus: (next) => {
        setStatus(next)
        if (next.kind === 'error') {
          if (!errorToastedRef.current) {
            errorToastedRef.current = true
            showToast(next.message, 'error')
          }
        } else if (next.kind === 'clean') {
          errorToastedRef.current = false
        }
      },
    })
    coordinatorRef.current = coordinator
    return () => {
      coordinator.dispose()
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null
    }
  }, [])

  useEffect(() => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    if (hydration.phase === 'ready' && hydration.persistEnabled && hydration.savedAt && hydration.html !== null) {
      coordinator.markClean(hydration.savedAt, hydration.html)
    } else if (hydration.phase === 'ready' && !hydration.persistEnabled) {
      coordinator.markDegraded(hydration.message || 'Document storage is unavailable.')
    }
  }, [hydration])

  useEffect(() => {
    if (!editor || !persistEnabledRef.current) return
    const onUpdate = () => {
      coordinatorRef.current?.scheduleSave()
    }
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor, hydration])

  useEffect(() => {
    return bindPageLifecycle(() => {
      void coordinatorRef.current?.flushNow()
    })
  }, [])

  const scheduleSave = useCallback(() => {
    coordinatorRef.current?.scheduleSave()
  }, [])

  const flushNow = useCallback(async (): Promise<SaveOutcome> => {
    const coordinator = coordinatorRef.current
    if (!coordinator) {
      return { ok: false, kind: 'error', message: 'Could not save the document.' }
    }
    return coordinator.flushNow()
  }, [])

  const createVersion = useCallback(async (
    description: string,
    opts?: { html?: string; notify?: boolean },
  ): Promise<VersionOutcome> => {
    if (!persistEnabledRef.current) {
      return { ok: false, kind: 'degraded', message: 'Document storage is unavailable.' }
    }
    if (!canPersistRef.current()) {
      return { ok: false, kind: 'skipped', message: 'Cannot save a version of a pending AI proposal.' }
    }
    const record: VersionRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      description,
      content: opts?.html ?? getPersistableRef.current(),
    }
    try {
      const saved = await persistVersion(record)
      setVersions(prev => [saved, ...prev.filter(item => item.id !== saved.id)])
      setVersionsError(null)
      versionErrorToastedRef.current = false
      void refreshVersions()
      return { ok: true, version: saved }
    } catch (error) {
      const message = error instanceof PersistenceError
        ? error.message
        : 'Could not save a version.'
      const kind = error instanceof PersistenceError && error.code === 'unavailable' ? 'degraded' : 'error'
      setVersionsError(message)
      if (opts?.notify !== false && !versionErrorToastedRef.current) {
        versionErrorToastedRef.current = true
        showToast(message, 'error')
      }
      return { ok: false, kind, message }
    }
  }, [refreshVersions])

  const replaceCurrentDocument = useCallback(async (
    nextHtml: string,
    description: string,
  ): Promise<ReplaceDocumentOutcome> => {
    const coordinator = coordinatorRef.current
    if (!coordinator) {
      return { ok: false, replaced: false, kind: 'error', message: RECOVERY_BLOCK_MESSAGE }
    }
    const prep = await prepareDestructiveDocumentChange(description, {
      persistEnabled: persistEnabledRef.current,
      storageUnavailable: coordinator.getStatus().kind === 'degraded' || !persistEnabledRef.current,
      getSnapshot: () => getPersistableRef.current(),
      flushNow,
      createVersion: (desc, html) => createVersion(desc, { html, notify: false }),
      beginDestructiveTransition: () => coordinator.beginDestructiveTransition(),
    })
    if (!prep.ok) {
      showToast(RECOVERY_BLOCK_MESSAGE, 'error')
      return { ok: false, replaced: false, kind: prep.kind, message: prep.message }
    }
    if (!editor) {
      prep.applyReplacement(() => {})
      return { ok: false, replaced: false, kind: 'error', message: RECOVERY_BLOCK_MESSAGE }
    }
    prep.applyReplacement(() => {
      editor.commands.setContent(nextHtml)
    })
    const after = await flushNow()
    if (!after.ok) {
      return { ok: false, replaced: true, kind: after.kind, message: after.message }
    }
    return { ok: true, replaced: true, savedAt: after.savedAt }
  }, [createVersion, editor, flushNow])

  const saveManualVersionNow = useCallback(async () => {
    return saveManualVersion(flushNow, description => createVersion(description))
  }, [createVersion, flushNow])

  const persistAfterAcceptNow = useCallback(async () => {
    return persistAfterAccept(flushNow, description => createVersion(description))
  }, [createVersion, flushNow])

  const persistAfterRejectNow = useCallback(async () => {
    return persistAfterReject(flushNow)
  }, [flushNow])

  const deleteVersion = useCallback(async (id: string) => {
    try {
      await persistDeleteVersion(id)
      setVersions(prev => prev.filter(item => item.id !== id))
    } catch (error) {
      const message = error instanceof PersistenceError
        ? error.message
        : 'Could not delete the version.'
      setVersionsError(message)
      showToast(message, 'error')
      throw error
    }
  }, [])

  const startNewDocumentFromBlocked = useCallback(() => {
    setHydration({
      phase: 'ready',
      html: null,
      savedAt: null,
      persistEnabled: true,
      degraded: false,
      message: null,
    })
    persistEnabledRef.current = true
    setStatus({ kind: 'dirty' })
  }, [])

  const value = useMemo<PersistenceApi>(() => ({
    hydration,
    status,
    persistEnabled: persistEnabledOf(hydration),
    scheduleSave,
    flushNow,
    createVersion,
    replaceCurrentDocument,
    saveManualVersion: saveManualVersionNow,
    persistAfterAccept: persistAfterAcceptNow,
    persistAfterReject: persistAfterRejectNow,
    deleteVersion,
    versions,
    versionsError,
    versionsBusy,
    refreshVersions,
    startNewDocumentFromBlocked,
  }), [
    hydration,
    status,
    scheduleSave,
    flushNow,
    createVersion,
    replaceCurrentDocument,
    saveManualVersionNow,
    persistAfterAcceptNow,
    persistAfterRejectNow,
    deleteVersion,
    versions,
    versionsError,
    versionsBusy,
    refreshVersions,
    startNewDocumentFromBlocked,
  ])

  return (
    <PersistenceContext.Provider value={value}>
      {hydration.phase === 'loading'
        ? (
            <div className="flex flex-col h-screen" aria-busy="true" aria-label="Loading document">
              <div className="flex-1 grid place-items-center text-sm text-[var(--color-text-tertiary)]">
                Loading document…
              </div>
            </div>
          )
        : children}
    </PersistenceContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePersistence(): PersistenceApi {
  const ctx = useContext(PersistenceContext)
  if (!ctx) throw new Error('usePersistence must be used within PersistenceProvider')
  return ctx
}


