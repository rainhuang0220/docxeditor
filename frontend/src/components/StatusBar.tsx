import { useState, useEffect, useCallback, useRef } from 'react'
import { Minus, Plus, Target } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { apiUrl } from '../utils/api'

export function StatusBar() {
  const { editor } = useEditorContext()
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const [zoom, setZoom] = useState(100)
  const [, forceUpdate] = useState(0)
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null)
  const [wordGoal, setWordGoal] = useState<number | null>(() => {
    const stored = localStorage.getItem('ai-doc-ide-word-goal')
    return stored ? parseInt(stored) : null
  })

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
    <div className="flex items-center gap-4 px-4 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[11px] text-[var(--color-text-tertiary)] font-[var(--font-mono)]" role="status" aria-label="Document statistics">
      <span>Ln {currentLine}, Col {from - editor.state.doc.resolve(from).start() + 1}</span>
      <span>Words: {wordCount}</span>
      <span>Characters: {charCount}</span>
      <span>Paragraphs: {paragraphCount}</span>
      {wordCount > 0 && <span>{Math.max(1, Math.ceil(wordCount / 200))} min read</span>}
      {selectedCount > 0 && <span className="text-[var(--color-primary)]">Selected: {selectedCount}</span>}
      {/* Word goal progress */}
      {wordGoal && (
        <span className="flex items-center gap-1.5" title={`${wordCount} / ${wordGoal} words`}>
          <div className="w-16 h-1 bg-[var(--color-surface-tertiary)] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${wordCount >= wordGoal ? 'bg-emerald-500' : 'bg-[var(--color-primary)]'}`}
              style={{ width: `${Math.min(100, (wordCount / wordGoal) * 100)}%` }}
            />
          </div>
          <span className={wordCount >= wordGoal ? 'text-emerald-500' : ''}>{Math.round((wordCount / wordGoal) * 100)}%</span>
        </span>
      )}
      <WordGoalButton wordGoal={wordGoal} setWordGoal={setWordGoal} />
      <div className="flex-1" />
      {lastSaved && <span className="text-[var(--color-text-muted)]">Saved {lastSaved}</span>}
      <span className={`flex items-center gap-1.5 ${backendOnline ? 'text-emerald-500' : 'text-red-400'}`} title={backendOnline ? 'Backend connected' : 'Backend offline'}>
        <span className={`w-1.5 h-1.5 rounded-full ${backendOnline ? 'bg-emerald-500' : 'bg-red-400'} ${backendOnline ? 'shadow-[0_0_6px_rgba(16,185,129,0.6)]' : ''}`} />
        {backendOnline ? 'AI Ready' : 'Offline'}
      </span>
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setZoom(z => Math.max(50, z - 10))}
          className="p-1 rounded-md hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Zoom out"
        >
          <Minus size={12} />
        </button>
        <span className="w-9 text-center">{zoom}%</span>
        <button
          onClick={() => setZoom(z => Math.min(200, z + 10))}
          className="p-1 rounded-md hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Zoom in"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  )
}

function WordGoalButton({ wordGoal, setWordGoal }: { wordGoal: number | null, setWordGoal: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [inputVal, setInputVal] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const open = () => {
    setInputVal(wordGoal?.toString() || '')
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const save = () => {
    const n = parseInt(inputVal)
    if (!n || n <= 0) {
      setWordGoal(null)
      localStorage.removeItem('ai-doc-ide-word-goal')
    } else {
      setWordGoal(n)
      localStorage.setItem('ai-doc-ide-word-goal', n.toString())
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="number"
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={save}
          placeholder="Goal"
          className="w-14 text-[11px] font-[var(--font-mono)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-primary)] rounded-md px-1.5 py-0.5 focus:outline-none focus:border-[var(--color-primary)]"
        />
      </div>
    )
  }

  return (
    <button
      onClick={open}
      className={`p-1 rounded-md hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors ${wordGoal ? 'text-[var(--color-primary)]' : ''}`}
      title={wordGoal ? `Goal: ${wordGoal} words (click to edit)` : 'Set word goal'}
    >
      <Target size={12} />
    </button>
  )
}
