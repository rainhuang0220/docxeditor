import { useState } from 'react'
import { History, ChevronDown, RotateCcw, Eye, Trash2, X } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { DiffView } from './DiffView'
import { usePersistence } from '../persistence/PersistenceContext'
import type { VersionRecord } from '../persistence/types'

export function VersionPanel() {
  const { editor, guardSession } = useEditorContext()
  const {
    createVersion,
    deleteVersion,
    versions,
    versionsError,
    versionsBusy,
    beginDestructiveTransition,
    flushNow,
  } = usePersistence()
  const [isOpen, setIsOpen] = useState(false)
  const [diffVersion, setDiffVersion] = useState<VersionRecord | null>(null)
  const [saving, setSaving] = useState(false)

  const saveVersion = async (description: string) => {
    if (!editor || saving) return
    setSaving(true)
    try {
      await createVersion(description)
    } catch {
      /* persistence layer surfaces the error */
    } finally {
      setSaving(false)
    }
  }

  const restoreVersion = async (version: VersionRecord) => {
    if (!editor) return
    if (!guardSession('mutateDocument')) return
    try {
      await createVersion('Auto-save before restore')
    } catch {
      /* still restore; version failure is visible */
    }
    await beginDestructiveTransition()
    editor.commands.setContent(version.content)
    await flushNow()
  }

  const removeVersion = async (id: string) => {
    try {
      await deleteVersion(id)
      if (diffVersion?.id === id) setDiffVersion(null)
    } catch {
      /* toasted */
    }
  }

  const getRelativeTime = (timestamp: string) => {
    const diff = Date.now() - new Date(timestamp).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return new Date(timestamp).toLocaleDateString()
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="menu-surface fixed bottom-4 left-4 flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] transition-colors"
      >
        <History size={13} />
        <span>History</span>
        <span className="font-mono text-[var(--color-text-muted)]">{versions.length}</span>
      </button>
    )
  }

  const currentText = editor?.state.doc.textContent || ''

  return (
    <>
      <div className="menu-surface fixed bottom-4 left-4 w-72 z-30 anim-pop" style={{ transformOrigin: 'bottom left' }}>
        <div className="flex items-center justify-between px-3.5 h-9 border-b border-[var(--color-border-light)]">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-primary)] tracking-[-0.01em]">
            <History size={13} />
            <span>Version History</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { void saveVersion('Manual save') }}
              className="btn btn-primary"
              disabled={saving || versionsBusy}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setIsOpen(false)} className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors">
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
        {versionsError && (
          <p className="px-3.5 py-2 text-[11px] text-[var(--color-danger)]">{versionsError}</p>
        )}
        <div className="max-h-60 overflow-y-auto py-1">
          {versions.length === 0 ? (
            <p className="p-3 text-xs text-[var(--color-text-muted)] text-center">
              {versionsBusy ? 'Loading versions…' : 'No versions saved yet.'}
            </p>
          ) : (
            versions.map(v => (
              <div key={v.id} className="flex items-center justify-between px-3.5 py-2 hover:bg-[var(--color-surface-secondary)] group transition-colors">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-[var(--color-text-primary)] truncate">{v.description}</p>
                  <p className="font-mono text-[10.5px] text-[var(--color-text-muted)]">{getRelativeTime(v.timestamp)}</p>
                </div>
                <div className="flex items-center gap-0.5 ml-2">
                  <button
                    onClick={() => setDiffVersion(diffVersion?.id === v.id ? null : v)}
                    className={`p-1 transition-colors ${diffVersion?.id === v.id ? 'text-[var(--color-accent-text)] bg-[var(--color-surface-secondary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-accent-text)] hover:bg-[var(--color-surface-secondary)]'}`}
                    title="Compare with current"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    onClick={() => { void restoreVersion(v) }}
                    className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent-text)] hover:bg-[var(--color-surface-secondary)] transition-colors"
                    title="Restore this version"
                  >
                    <RotateCcw size={13} />
                  </button>
                  <button
                    onClick={() => { void removeVersion(v.id) }}
                    className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-surface-secondary)] opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete version"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {diffVersion && (
        <div className="menu-surface fixed bottom-4 left-[316px] w-96 max-h-80 z-30 flex flex-col anim-pop" style={{ transformOrigin: 'bottom left' }}>
          <div className="flex items-center justify-between px-3.5 h-9 border-b border-[var(--color-border-light)]">
            <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">
              Changes since: {diffVersion.description}
            </span>
            <button onClick={() => setDiffVersion(null)} className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors">
              <X size={13} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3.5">
            <DiffView
              oldText={stripHtml(diffVersion.content)}
              newText={currentText}
            />
          </div>
        </div>
      )}
    </>
  )
}

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || ''
}
