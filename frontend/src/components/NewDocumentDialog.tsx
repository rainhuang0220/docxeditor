import { useState } from 'react'
import { FilePlus, X } from 'lucide-react'
import { DOCUMENT_TEMPLATES } from '../templates/documents'
import { useEditorContext } from '../context/EditorContext'

export function NewDocumentDialog() {
  const { editor, setDocumentTitle } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  const applyTemplate = (key: string) => {
    if (!editor) return
    // Confirm if document has content
    const hasContent = editor.state.doc.textContent.trim().length > 50
    if (hasContent) {
      setConfirmKey(key)
      return
    }
    doApply(key)
  }

  const doApply = (key: string) => {
    const template = DOCUMENT_TEMPLATES[key as keyof typeof DOCUMENT_TEMPLATES]
    if (template) {
      editor!.commands.setContent(template.content)
      setDocumentTitle(template.name === 'Blank' ? 'Untitled Document' : template.name)
    }
    setConfirmKey(null)
    setIsOpen(false)
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="tool-btn w-[30px] h-[30px] grid place-items-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
        title="New Document"
      >
        <FilePlus size={16} />
      </button>

      {isOpen && (
        <>
          <div className="dialog-backdrop" onClick={() => setIsOpen(false)} />
          <div className="dialog-panel w-[540px] max-w-[90vw] p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="dialog-title">New Document</h3>
              <button onClick={() => setIsOpen(false)} className="dialog-close">
                <X size={15} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5 max-h-[60vh] overflow-y-auto">
              {Object.entries(DOCUMENT_TEMPLATES).map(([key, tmpl]) => (
                <button
                  key={key}
                  onClick={() => applyTemplate(key)}
                  className="text-left p-4 border border-[var(--color-border-light)] rounded-lg hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
                >
                  <p className="font-medium text-[14px] text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] tracking-[-0.01em]">{tmpl.name}</p>
                  <p className="text-[13px] text-[var(--color-text-tertiary)] mt-1.5 line-clamp-2 leading-relaxed">
                    {tmpl.description}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {confirmKey && (
        <>
          <div className="dialog-backdrop z-[60]" onClick={() => setConfirmKey(null)} />
          <div className="dialog-panel z-[70] w-[380px] max-w-[90vw] p-6">
            <p className="text-[14px] text-[var(--color-text-secondary)] mb-6 leading-relaxed">
              This will replace your current document. Continue?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmKey(null)} className="btn btn-secondary">
                Cancel
              </button>
              <button onClick={() => doApply(confirmKey)} className="btn btn-primary">
                Replace
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
