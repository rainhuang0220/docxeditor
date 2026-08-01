import { useState, useEffect } from 'react'
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

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-8 h-full border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex items-start justify-center pt-3 hover:bg-gray-50 dark:hover:bg-gray-700"
        title="Show Outline"
      >
        <FileText size={16} className="text-gray-500" />
      </button>
    )
  }

  return (
    <div className="w-52 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Outline</span>
        <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {outline.length === 0 ? (
          <p className="px-3 py-2 text-xs text-gray-400">No headings found.</p>
        ) : (
          outline.map(item => (
            <button
              key={item.id}
              onClick={() => {
                if (!editor) return
                editor.commands.focus()
                editor.commands.setTextSelection(item.pos + 1)
                // Scroll the editor to the heading
                const domNode = editor.view.domAtPos(item.pos + 1)
                if (domNode.node instanceof HTMLElement) {
                  domNode.node.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
              }}
              className="w-full text-left px-3 py-1 text-xs hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-700 dark:text-gray-300 truncate"
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
