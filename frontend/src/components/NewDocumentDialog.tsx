import { useState } from 'react'
import { FilePlus, X } from 'lucide-react'
import { DOCUMENT_TEMPLATES } from '../templates/documents'
import { useEditorContext } from '../context/EditorContext'

export function NewDocumentDialog() {
  const { editor, setDocumentTitle } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)

  const applyTemplate = (key: string) => {
    if (!editor) return
    // Confirm if document has content
    const hasContent = editor.state.doc.textContent.trim().length > 50
    if (hasContent && !window.confirm('This will replace your current document. Continue?')) {
      return
    }
    const template = DOCUMENT_TEMPLATES[key as keyof typeof DOCUMENT_TEMPLATES]
    if (template) {
      editor.commands.setContent(template.content)
      setDocumentTitle(template.name === 'Blank' ? 'Untitled Document' : template.name)
    }
    setIsOpen(false)
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
        title="New Document"
      >
        <FilePlus size={16} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setIsOpen(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 rounded-lg shadow-xl z-50 w-[500px] p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">New Document</h3>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {Object.entries(DOCUMENT_TEMPLATES).map(([key, tmpl]) => (
                <button
                  key={key}
                  onClick={() => applyTemplate(key)}
                  className="text-left p-3 border border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  <p className="font-medium text-sm text-gray-800 dark:text-gray-100">{tmpl.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                    {key === 'blank' && 'Start with an empty document'}
                    {key === 'report' && 'Professional report with sections'}
                    {key === 'proposal' && 'Project proposal template'}
                    {key === 'letter' && 'Formal business letter'}
                    {key === 'academic' && 'Academic paper with citations'}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
