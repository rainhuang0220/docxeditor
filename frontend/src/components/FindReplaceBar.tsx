import { useState, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'

export function FindReplaceBar() {
  const { editor } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [matchCount, setMatchCount] = useState(0)

  useEffect(() => {
    const handler = () => setIsOpen(true)
    window.addEventListener('editor:open-find-replace', handler)
    return () => window.removeEventListener('editor:open-find-replace', handler)
  }, [])

  const handleFind = () => {
    if (!editor || !findText) return
    const content = editor.state.doc.textContent
    const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const matches = content.match(regex)
    setMatchCount(matches?.length || 0)
  }

  const handleReplace = () => {
    if (!editor || !findText) return
    const html = editor.getHTML()
    const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    const newHtml = html.replace(regex, replaceText)
    editor.commands.setContent(newHtml)
    handleFind()
  }

  const handleReplaceAll = () => {
    if (!editor || !findText) return
    const html = editor.getHTML()
    const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const newHtml = html.replace(regex, replaceText)
    editor.commands.setContent(newHtml)
    setMatchCount(0)
  }

  if (!isOpen) return null

  return (
    <div className="absolute top-2 right-2 z-30 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 w-80">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Find & Replace</span>
        <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <X size={14} />
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex gap-1">
          <input
            type="text"
            value={findText}
            onChange={e => setFindText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleFind()}
            placeholder="Find..."
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <button
            onClick={handleFind}
            className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-200 dark:hover:bg-gray-600 dark:text-gray-200"
          >
            <Search size={12} />
          </button>
        </div>

        <div className="flex gap-1">
          <input
            type="text"
            value={replaceText}
            onChange={e => setReplaceText(e.target.value)}
            placeholder="Replace with..."
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleReplace}
            className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-200 dark:hover:bg-gray-600 dark:text-gray-200"
            title="Replace next"
          >
            1
          </button>
          <button
            onClick={handleReplaceAll}
            className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-200 dark:hover:bg-gray-600 dark:text-gray-200"
            title="Replace all"
          >
            All
          </button>
        </div>

        {matchCount > 0 && (
          <p className="text-xs text-gray-500">{matchCount} match{matchCount > 1 ? 'es' : ''} found</p>
        )}
        {findText && matchCount === 0 && (
          <p className="text-xs text-gray-400">No matches found</p>
        )}
      </div>
    </div>
  )
}
