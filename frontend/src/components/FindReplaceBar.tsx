import { useState, useEffect, useRef, useCallback } from 'react'
import { X, ChevronDown, ChevronUp, CaseSensitive, Regex } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { TextSelection } from '@tiptap/pm/state'

interface Match {
  from: number
  to: number
}

export function FindReplaceBar() {
  const { editor } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = () => {
      setIsOpen(true)
      setTimeout(() => findInputRef.current?.focus(), 50)
    }
    window.addEventListener('editor:open-find-replace', handler)
    return () => window.removeEventListener('editor:open-find-replace', handler)
  }, [])

  const scrollToMatch = useCallback((match: Match) => {
    if (!editor) return
    const { tr } = editor.state
    tr.setSelection(TextSelection.create(tr.doc, match.from, match.to))
    editor.view.dispatch(tr)
    editor.view.focus()
  }, [editor])

  const findAllMatches = useCallback(() => {
    if (!editor || !findText) {
      setMatches([])
      setCurrentIndex(-1)
      return
    }
    const results: Match[] = []

    if (useRegex) {
      // Regex search across full document text
      try {
        const flags = caseSensitive ? 'g' : 'gi'
        const regex = new RegExp(findText, flags)
        // Build full text with position mapping
        const textParts: { text: string; pos: number }[] = []
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text) {
            textParts.push({ text: node.text, pos })
          }
        })
        for (const part of textParts) {
          let m: RegExpExecArray | null
          regex.lastIndex = 0
          while ((m = regex.exec(part.text)) !== null) {
            results.push({ from: part.pos + m.index, to: part.pos + m.index + m[0].length })
            if (m[0].length === 0) regex.lastIndex++
          }
        }
      } catch {
        // Invalid regex, ignore
      }
    } else {
      // Plain text search
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return
        const nodeText = caseSensitive ? node.text : node.text.toLowerCase()
        const search = caseSensitive ? findText : findText.toLowerCase()
        let idx = nodeText.indexOf(search)
        while (idx !== -1) {
          results.push({ from: pos + idx, to: pos + idx + findText.length })
          idx = nodeText.indexOf(search, idx + 1)
        }
      })
    }

    setMatches(results)
    if (results.length > 0) {
      setCurrentIndex(0)
      scrollToMatch(results[0])
    } else {
      setCurrentIndex(-1)
    }
  }, [editor, findText, caseSensitive, useRegex, scrollToMatch])

  const goNext = () => {
    if (matches.length === 0) return
    const next = (currentIndex + 1) % matches.length
    setCurrentIndex(next)
    scrollToMatch(matches[next])
  }

  const goPrev = () => {
    if (matches.length === 0) return
    const prev = (currentIndex - 1 + matches.length) % matches.length
    setCurrentIndex(prev)
    scrollToMatch(matches[prev])
  }

  const handleReplace = () => {
    if (!editor || currentIndex < 0 || !matches[currentIndex]) return
    const match = matches[currentIndex]
    editor.chain().focus()
      .command(({ tr }) => {
        if (replaceText) {
          tr.insertText(replaceText, match.from, match.to)
        } else {
          tr.delete(match.from, match.to)
        }
        return true
      })
      .run()
    // Re-search after replace
    setTimeout(() => findAllMatches(), 10)
  }

  const handleReplaceAll = () => {
    if (!editor || matches.length === 0) return
    // Replace from end to start so positions stay valid
    const sorted = [...matches].sort((a, b) => b.from - a.from)
    editor.chain().focus()
      .command(({ tr }) => {
        for (const match of sorted) {
          if (replaceText) {
            tr.insertText(replaceText, match.from, match.to)
          } else {
            tr.delete(match.from, match.to)
          }
        }
        return true
      })
      .run()
    setMatches([])
    setCurrentIndex(-1)
  }

  const handleClose = () => {
    setIsOpen(false)
    setFindText('')
    setReplaceText('')
    setMatches([])
    setCurrentIndex(-1)
  }

  if (!isOpen) return null

  return (
    <div className="menu-surface anim-pop absolute top-4 right-4 z-30 p-3.5 w-[340px]">
      <div className="flex items-center justify-between mb-2.5">
        <span className="eyebrow">Find & Replace</span>
        <button onClick={handleClose} className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex gap-1">
          <input
            ref={findInputRef}
            type="text"
            value={findText}
            onChange={e => setFindText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (e.shiftKey) { goPrev() }
                else if (matches.length > 0) { goNext() }
                else { findAllMatches() }
              }
              if (e.key === 'Escape') handleClose()
            }}
            placeholder={useRegex ? "Regex pattern..." : "Find..."}
            className="flex-1 text-[13px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] rounded-md px-2.5 py-1.5 focus:outline-none focus:border-[var(--color-primary)] placeholder:text-[var(--color-text-muted)] transition-colors"
            autoFocus
          />
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            className={`p-1.5 rounded-md transition-colors ${caseSensitive ? 'bg-[var(--color-primary-light)] text-[var(--color-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]'}`}
            title="Case sensitive"
            aria-label="Toggle case sensitive"
          >
            <CaseSensitive size={14} />
          </button>
          <button
            onClick={() => setUseRegex(!useRegex)}
            className={`p-1.5 rounded-md transition-colors ${useRegex ? 'bg-[var(--color-primary-light)] text-[var(--color-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]'}`}
            title="Use regex"
            aria-label="Toggle regex"
          >
            <Regex size={14} />
          </button>
          <button onClick={findAllMatches} className="px-2.5 py-1.5 text-xs font-medium bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] transition-colors" title="Find">
            Find
          </button>
          <button onClick={goPrev} className="p-1.5 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors" title="Previous" aria-label="Previous match">
            <ChevronUp size={14} />
          </button>
          <button onClick={goNext} className="p-1.5 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors" title="Next" aria-label="Next match">
            <ChevronDown size={14} />
          </button>
        </div>

        <div className="flex gap-1">
          <input
            type="text"
            value={replaceText}
            onChange={e => setReplaceText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') handleClose() }}
            placeholder="Replace with..."
            className="flex-1 text-[13px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] rounded-md px-2.5 py-1.5 focus:outline-none focus:border-[var(--color-primary)] placeholder:text-[var(--color-text-muted)] transition-colors"
          />
          <button onClick={handleReplace} className="px-2.5 py-1.5 text-xs font-medium bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] transition-colors" title="Replace current">
            1
          </button>
          <button onClick={handleReplaceAll} className="px-2.5 py-1.5 text-xs font-medium bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] transition-colors" title="Replace all">
            All
          </button>
        </div>

        {matches.length > 0 && (
          <p className="text-[11px] font-[var(--font-mono)] text-[var(--color-text-tertiary)]">{currentIndex + 1} of {matches.length} match{matches.length > 1 ? 'es' : ''}</p>
        )}
        {findText && matches.length === 0 && currentIndex === -1 && (
          <p className="text-[11px] font-[var(--font-mono)] text-[var(--color-text-muted)]">No matches found</p>
        )}
      </div>
    </div>
  )
}
