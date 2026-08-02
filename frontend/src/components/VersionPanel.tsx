import { useState, useEffect, useCallback } from 'react'
import { History, ChevronDown, RotateCcw, Eye, Trash2, X } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { saveVersions, loadVersions } from '../utils/storage'
import { DiffView } from './DiffView'
import type { StoredVersion } from '../utils/storage'

export function VersionPanel() {
  const { editor } = useEditorContext()
  const [versions, setVersions] = useState<StoredVersion[]>(() => loadVersions())
  const [isOpen, setIsOpen] = useState(false)
  const [diffVersion, setDiffVersion] = useState<StoredVersion | null>(null)

  useEffect(() => {
    saveVersions(versions)
  }, [versions])

  const saveVersion = useCallback((description: string) => {
    if (!editor) return
    const newVersion: StoredVersion = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      description,
      content: editor.getHTML(),
    }
    setVersions(prev => [newVersion, ...prev])
  }, [editor])

  const restoreVersion = (version: StoredVersion) => {
    if (!editor) return
    saveVersion('Auto-save before restore')
    editor.commands.setContent(version.content)
  }

  const deleteVersion = (id: string) => {
    setVersions(prev => prev.filter(v => v.id !== id))
    if (diffVersion?.id === id) setDiffVersion(null)
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

  // Listen for save-version custom events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      saveVersion(detail?.description || 'Manual save')
    }
    window.addEventListener('editor:save-version', handler)
    return () => window.removeEventListener('editor:save-version', handler)
  }, [saveVersion])

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="menu-surface fixed bottom-4 left-4 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] transition-colors"
      >
        <History size={13} />
        <span>History</span>
        <span className="font-[var(--font-mono)] text-[var(--color-text-muted)]">{versions.length}</span>
      </button>
    )
  }

  const currentText = editor?.state.doc.textContent || ''

  return (
    <>
      <div className="menu-surface fixed bottom-4 left-4 w-72 z-30 anim-pop" style={{ transformOrigin: 'bottom left' }}>
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--color-border-light)]">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-primary)] tracking-[-0.01em]">
            <History size={13} />
            <span>Version History</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => saveVersion('Manual save')}
              className="text-xs px-2.5 py-1 bg-[var(--color-primary)] text-white rounded-md hover:bg-[var(--color-primary-hover)] transition-colors font-medium"
            >
              Save
            </button>
            <button onClick={() => setIsOpen(false)} className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors">
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto py-1">
          {versions.length === 0 ? (
            <p className="p-3 text-xs text-[var(--color-text-muted)] text-center">No versions saved yet.</p>
          ) : (
            versions.map(v => (
              <div key={v.id} className="flex items-center justify-between px-3.5 py-2 hover:bg-[var(--color-surface-secondary)] group transition-colors">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-[var(--color-text-primary)] truncate">{v.description}</p>
                  <p className="text-[11px] font-[var(--font-mono)] text-[var(--color-text-muted)]">{getRelativeTime(v.timestamp)}</p>
                </div>
                <div className="flex items-center gap-0.5 ml-2">
                  <button
                    onClick={() => setDiffVersion(diffVersion?.id === v.id ? null : v)}
                    className={`p-1 rounded-md transition-colors ${diffVersion?.id === v.id ? 'text-[var(--color-primary)] bg-[var(--color-primary-light)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)]'}`}
                    title="Compare with current"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    onClick={() => restoreVersion(v)}
                    className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors"
                    title="Restore this version"
                  >
                    <RotateCcw size={13} />
                  </button>
                  <button
                    onClick={() => deleteVersion(v.id)}
                    className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
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

      {/* Diff overlay */}
      {diffVersion && (
        <div className="menu-surface fixed bottom-4 left-[316px] w-96 max-h-80 z-30 flex flex-col anim-pop" style={{ transformOrigin: 'bottom left' }}>
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--color-border-light)]">
            <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">
              Changes since: {diffVersion.description}
            </span>
            <button onClick={() => setDiffVersion(null)} className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors">
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
