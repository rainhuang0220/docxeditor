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
        className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
        title="Table of Contents"
      >
        <BookOpen size={16} />
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-96 max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-100">Table of Contents</h3>
          <div className="flex items-center gap-1">
            <button onClick={generateToc} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No headings found in the document.</p>
          ) : (
            <div className="space-y-1">
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
                  className="w-full text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded px-2 py-1"
                  style={{ paddingLeft: `${(item.level - 1) * 16 + 8}px` }}
                >
                  <span className="text-gray-400 text-xs mr-2">H{item.level}</span>
                  {item.text}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={() => setIsOpen(false)}
            className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Close
          </button>
          <button
            onClick={insertToc}
            disabled={items.length === 0}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            Insert TOC
          </button>
        </div>
      </div>
    </div>
  )
}
