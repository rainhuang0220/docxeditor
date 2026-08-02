import { useState } from 'react'
import { BookOpen, X, RefreshCw } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'

interface TocItem {
  level: number
  text: string
  pos: number
}

export function TableOfContents() {
  const { editor } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)
  const [items, setItems] = useState<TocItem[]>([])

  const generateToc = () => {
    if (!editor) return
    const tocItems: TocItem[] = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        tocItems.push({
          level: node.attrs.level,
          text: node.textContent || 'Untitled',
          pos,
        })
      }
    })
    setItems(tocItems)
  }

  const insertToc = () => {
    if (!editor || items.length === 0) return
    const tocHtml = items.map(item => {
      const indent = '&nbsp;'.repeat((item.level - 1) * 4)
      return `<p>${indent}${item.text}</p>`
    }).join('')
    const html = `<h2>Table of Contents</h2>${tocHtml}<hr>`
    // Insert at the beginning of the document
    editor.chain().focus().insertContentAt(0, html).run()
    setIsOpen(false)
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => { setIsOpen(true); generateToc() }}
        className="tool-btn w-[30px] h-[30px] grid place-items-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
        title="Table of Contents"
      >
        <BookOpen size={16} />
      </button>
    )
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={() => setIsOpen(false)} />
      <div className="dialog-panel w-[420px] max-w-[90vw] max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-border-light)]">
          <h3 className="dialog-title">Table of Contents</h3>
          <div className="flex items-center gap-1">
            <button onClick={generateToc} className="dialog-close" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button onClick={() => setIsOpen(false)} className="dialog-close">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="text-[13px] text-[var(--color-text-muted)] text-center py-6">No headings found in the document.</p>
          ) : (
            <div className="space-y-0.5">
              {items.map((item, i) => (
                <button
                  key={i}
                  onClick={() => {
                    editor?.commands.focus()
                    editor?.commands.setTextSelection(item.pos + 1)
                    const domNode = editor?.view.domAtPos(item.pos + 1)
                    if (domNode?.node instanceof HTMLElement) {
                      domNode.node.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }
                  }}
                  className="w-full text-left text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)] rounded-md px-3 py-2 transition-colors"
                  style={{ paddingLeft: `${(item.level - 1) * 16 + 12}px` }}
                >
                  <span className="font-[var(--font-mono)] text-[var(--color-text-muted)] text-[10px] mr-2">H{item.level}</span>
                  {item.text}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-[var(--color-border-light)] flex justify-end gap-2">
          <button onClick={() => setIsOpen(false)} className="btn btn-secondary">
            Close
          </button>
          <button
            onClick={insertToc}
            disabled={items.length === 0}
            className="btn btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Insert TOC
          </button>
        </div>
      </div>
    </>
  )
}
