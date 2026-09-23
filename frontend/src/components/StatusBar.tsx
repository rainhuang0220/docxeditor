import { useState, useEffect, useCallback, useRef } from 'react'
import { Minus, Plus, Target } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { apiUrl } from '../utils/api'
import { usePersistence } from '../persistence/PersistenceContext'
import { formatPersistenceStatus } from '../persistence/status'

export function StatusBar() {
  const { editor } = useEditorContext()
  const { status: persistenceStatus } = usePersistence()
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
    <div className="flex items-center gap-3 px-4 h-7 border-t border-[var(--color-border)] bg-[var(--color-surface)] font-mono text-[10.5px] text-[var(--color-text-tertiary)] uppercase tracking-[0.06em]" role="status" aria-label="Document statistics">
      <span>Ln {currentLine}, Col {from - editor.state.doc.resolve(from).start() + 1}</span>
      <span className="text-[var(--color-text-muted)]">/</span>
      <span>{wordCount} w</span>
      <span>{charCount} ch</span>
      <span>{paragraphCount} ¶</span>
      {wordCount > 0 && <span className="text-[var(--color-text-muted)]">{Math.max(1, Math.ceil(wordCount / 200))} min</span>}
      {selectedCount > 0 && <span className="text-[var(--color-accent-text)] normal-case tracking-normal">Sel {selectedCount}</span>}
      {/* Word goal progress */}
      {wordGoal && (
        <span className="flex items-center gap-2" title={`${wordCount} / ${wordGoal} words`}>
          <div className="w-16 h-[3px] bg-[var(--color-border-light)]">
            <div
              className={`h-full transition-all ${wordCount >= wordGoal ? 'bg-[var(--color-success)]' : 'bg-[var(--color-primary)]'}`}
              style={{ width: `${Math.min(100, (wordCount / wordGoal) * 100)}%` }}
            />
          </div>
          <span className={wordCount >= wordGoal ? 'text-[var(--color-success)]' : ''}>{Math.round((wordCount / wordGoal) * 100)}%</span>
        </span>
      )}
      <WordGoalButton wordGoal={wordGoal} setWordGoal={setWordGoal} />
      <div className="flex-1" />
      <span
        className={`normal-case tracking-normal ${
          persistenceStatus.kind === 'error' || persistenceStatus.kind === 'degraded'
            ? 'text-[var(--color-danger)]'
            : persistenceStatus.kind === 'dirty'
              ? 'text-[var(--color-text-secondary)]'
              : 'text-[var(--color-text-muted)]'
        }`}
        data-persistence-kind={persistenceStatus.kind}
      >
        {formatPersistenceStatus(persistenceStatus)}
      </span>
      <span className={`flex items-center gap-1.5 normal-case tracking-normal ${backendOnline ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`} title={backendOnline ? 'Backend connected' : 'Backend offline'}>
        <span className={`w-1.5 h-1.5 ${backendOnline ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`} />
        {backendOnline ? 'AI Ready' : 'Offline'}
      </span>
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setZoom(z => Math.max(50, z - 10))}
          className="w-5 h-5 grid place-items-center hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Zoom out"
        >
          <Minus size={11} />
        </button>
        <span className="w-9 text-center text-[var(--color-text-secondary)] tabular-nums">{zoom}%</span>
        <button
          onClick={() => setZoom(z => Math.min(200, z + 10))}
          className="w-5 h-5 grid place-items-center hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Zoom in"
        >
          <Plus size={11} />
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
          className="w-14 font-mono text-[11px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-primary)] px-1.5 py-0.5 focus:outline-none focus:border-[var(--color-accent-text)]"
        />
      </div>
    )
  }

  return (
    <button
      onClick={open}
      className={`w-5 h-5 grid place-items-center hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors ${wordGoal ? 'text-[var(--color-accent-text)]' : ''}`}
      title={wordGoal ? `Goal: ${wordGoal} words (click to edit)` : 'Set word goal'}
    >
      <Target size={12} />
    </button>
  )
}
