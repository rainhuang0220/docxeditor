import { useState, useEffect, useCallback } from 'react'
import { Minus, Plus, Wifi, WifiOff } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { apiUrl } from '../utils/api'

export function StatusBar() {
  const { editor } = useEditorContext()
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const [zoom, setZoom] = useState(100)
  const [, forceUpdate] = useState(0)
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null)

  useEffect(() => {
    const checkBackend = () => {
      fetch(apiUrl('/api/health'))
        .then(res => setBackendOnline(res.ok))
        .catch(() => setBackendOnline(false))
    }
    checkBackend()
    const interval = setInterval(checkBackend, 15000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const raw = localStorage.getItem('ai-doc-ide-document')
        if (raw) {
          const data = JSON.parse(raw)
          if (data.savedAt) {
            const d = new Date(data.savedAt)
            setLastSaved(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
          }
        }
      } catch { /* ignore */ }
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  // Re-render on selection/content changes
  const handleUpdate = useCallback(() => forceUpdate(n => n + 1), [])
  useEffect(() => {
    if (!editor) return
    editor.on('selectionUpdate', handleUpdate)
    editor.on('update', handleUpdate)
    return () => {
      editor.off('selectionUpdate', handleUpdate)
      editor.off('update', handleUpdate)
    }
  }, [editor, handleUpdate])

  useEffect(() => {
    const editorArea = document.querySelector('.flex-1.overflow-y-auto') as HTMLElement
    if (editorArea) {
      editorArea.style.zoom = `${zoom}%`
    }
  }, [zoom])

  if (!editor) return null

  const { from, to } = editor.state.selection
  const text = editor.state.doc.textContent
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0
  const charCount = text.length
  const selectedText = editor.state.doc.textBetween(from, to, ' ')
  const selectedCount = selectedText.length

  // Count paragraphs
  let paragraphCount = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'paragraph' || node.type.name === 'heading') {
      paragraphCount++
    }
  })

  // Resolve current line number (paragraph index)
  let currentLine = 0
  let idx = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' || node.type.name === 'heading') {
      idx++
      if (pos <= from) currentLine = idx
    }
  })

  return (
    <div className="flex items-center gap-4 px-3 py-1 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400" role="status" aria-label="Document statistics">
      <span>Ln {currentLine}, Col {from - editor.state.doc.resolve(from).start() + 1}</span>
      <span>Words: {wordCount}</span>
      <span>Characters: {charCount}</span>
      <span>Paragraphs: {paragraphCount}</span>
      {selectedCount > 0 && <span>Selected: {selectedCount}</span>}
      <div className="flex-1" />
      {lastSaved && <span className="text-gray-400">Saved {lastSaved}</span>}
      <span className={`flex items-center gap-1 ${backendOnline ? 'text-green-500' : 'text-red-400'}`} title={backendOnline ? 'Backend connected' : 'Backend offline'}>
        {backendOnline ? <Wifi size={11} /> : <WifiOff size={11} />}
        {backendOnline ? 'AI Ready' : 'Offline'}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setZoom(z => Math.max(50, z - 10))}
          className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          title="Zoom out"
        >
          <Minus size={12} />
        </button>
        <span className="w-8 text-center">{zoom}%</span>
        <button
          onClick={() => setZoom(z => Math.min(200, z + 10))}
          className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          title="Zoom in"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  )
}
