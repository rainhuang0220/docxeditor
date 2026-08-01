import { useState, useEffect, useCallback } from 'react'
import { History, ChevronDown, RotateCcw } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { saveVersions, loadVersions } from '../utils/storage'
import type { StoredVersion } from '../utils/storage'

export function VersionPanel() {
  const { editor } = useEditorContext()
  const [versions, setVersions] = useState<StoredVersion[]>(() => loadVersions())
  const [isOpen, setIsOpen] = useState(false)

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
        className="fixed bottom-4 left-4 flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        <History size={14} />
        <span>History ({versions.length})</span>
      </button>
    )
  }

  return (
    <div className="fixed bottom-4 left-4 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
          <History size={14} />
          <span>Version History</span>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => saveVersion('Manual save')}
            className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Save
          </button>
          <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div className="max-h-60 overflow-y-auto">
        {versions.length === 0 ? (
          <p className="p-3 text-xs text-gray-400 text-center">No versions saved yet.</p>
        ) : (
          versions.map(v => (
            <div key={v.id} className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
              <div>
                <p className="text-xs font-medium text-gray-700 dark:text-gray-200">{v.description}</p>
                <p className="text-xs text-gray-400">
                  {new Date(v.timestamp).toLocaleTimeString()}
                </p>
              </div>
              <button
                onClick={() => restoreVersion(v)}
                className="text-gray-400 hover:text-blue-600"
                title="Restore this version"
              >
                <RotateCcw size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
