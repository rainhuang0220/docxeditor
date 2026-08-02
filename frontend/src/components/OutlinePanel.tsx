import { useState, useEffect, useCallback } from 'react'
import { FileText, ChevronRight } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'

interface OutlineItem {
  id: string
  level: number
  text: string
  pos: number
}

export function OutlinePanel() {
  const { editor } = useEditorContext()
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [isOpen, setIsOpen] = useState(true)
  const [activeHeadingPos, setActiveHeadingPos] = useState<number | null>(null)

  useEffect(() => {
    if (!editor) return

    const updateOutline = () => {
      const items: OutlineItem[] = []
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          items.push({
            id: `heading-${pos}`,
            level: node.attrs.level,
            text: node.textContent || 'Untitled',
            pos,
          })
        }
      })
      setOutline(items)
    }

    updateOutline()
    editor.on('update', updateOutline)
    return () => { editor.off('update', updateOutline) }
  }, [editor])

  // Track cursor position to highlight the nearest heading above
  const updateActiveHeading = useCallback(() => {
    if (!editor || outline.length === 0) return
    const { from } = editor.state.selection
    let closest: number | null = null
    for (const item of outline) {
      if (item.pos <= from) closest = item.pos
      else break
    }
    setActiveHeadingPos(closest)
  }, [editor, outline])

  useEffect(() => {
    if (!editor) return
    editor.on('selectionUpdate', updateActiveHeading)
    editor.on('update', updateActiveHeading)
    updateActiveHeading()
    return () => {
      editor.off('selectionUpdate', updateActiveHeading)
      editor.off('update', updateActiveHeading)
    }
  }, [editor, updateActiveHeading])

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="chrome-panel w-8 h-full border-r border-[var(--color-border)] bg-[var(--color-surface)] flex items-start justify-center pt-3 hover:bg-[var(--color-surface-secondary)] transition-colors"
        title="Show Outline"
      >
        <FileText size={15} className="text-[var(--color-text-tertiary)]" />
      </button>
    )
  }

  return (
    <div className="chrome-panel w-52 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-light)]">
        <span className="eyebrow">Outline</span>
        <button onClick={() => setIsOpen(false)} className="p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors">
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1.5">
        {outline.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--color-text-muted)] text-center">No headings found</p>
        ) : (
          outline.map(item => (
            <button
              key={item.id}
              onClick={() => {
                if (!editor) return
                editor.commands.focus()
                editor.commands.setTextSelection(item.pos + 1)
                const domNode = editor.view.domAtPos(item.pos + 1)
                if (domNode.node instanceof HTMLElement) {
                  domNode.node.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
              }}
              className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${activeHeadingPos === item.pos ? 'bg-[var(--color-primary-light)] text-[var(--color-primary)] font-medium border-l-2 border-[var(--color-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] border-l-2 border-transparent'}`}
              style={{ paddingLeft: `${(item.level - 1) * 12 + 12}px` }}
            >
              {item.text}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
