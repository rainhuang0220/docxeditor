import { useState } from 'react'
import { Table as TableIcon, X } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'

export function InsertTableDialog() {
  const { editor } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)
  const [rows, setRows] = useState(3)
  const [cols, setCols] = useState(3)
  const [withHeader, setWithHeader] = useState(true)

  const insert = () => {
    if (!editor) return
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: withHeader }).run()
    setIsOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title="Insert Table"
        aria-label="Insert Table"
        className="tool-btn w-[30px] h-[30px] grid place-items-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <TableIcon size={16} />
      </button>

      {isOpen && (
        <>
          <div className="dialog-backdrop" onClick={() => setIsOpen(false)} />
          <div className="dialog-panel p-6 w-[300px] max-w-[90vw]">
            <div className="flex items-center justify-between mb-5">
              <h3 className="dialog-title">Insert Table</h3>
              <button onClick={() => setIsOpen(false)} className="dialog-close">
                <X size={15} />
              </button>
            </div>

            <div className="space-y-3.5">
              <div className="flex items-center justify-between gap-3">
                <label className="field-label mb-0">Rows</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={rows}
                  onChange={e => setRows(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  className="field-input w-20"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="field-label mb-0">Columns</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={cols}
                  onChange={e => setCols(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  className="field-input w-20"
                />
              </div>
              <label className="flex items-center gap-2.5 text-[12.5px] text-[var(--color-text-secondary)] pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={withHeader}
                  onChange={e => setWithHeader(e.target.checked)}
                  className="accent-[var(--color-primary)] w-3.5 h-3.5"
                />
                Include header row
              </label>
            </div>

            <button onClick={insert} className="btn btn-primary mt-5 w-full">
              Insert
            </button>
          </div>
        </>
      )}
    </>
  )
}
