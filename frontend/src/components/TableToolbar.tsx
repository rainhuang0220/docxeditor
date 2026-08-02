import { useRef } from 'react'
import {
  Rows3, Columns3, Trash2, Plus, ArrowDown, ArrowUp, ArrowLeft, ArrowRight,
  Merge, Split, Paintbrush, PanelTop,
} from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'

export function TableToolbar() {
  const { editor } = useEditorContext()
  const cellColorRef = useRef<HTMLInputElement>(null)

  if (!editor || !editor.isActive('table')) return null

  return (
    <div className="flex items-center gap-0.5 px-3 py-1 bg-[var(--color-surface)] border-b border-[var(--color-border)] text-xs">
      <span className="eyebrow-accent mr-2">Table</span>

      <TBtn onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row below">
        <ArrowDown size={13} /><Plus size={10} className="-ml-1" />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().addRowBefore().run()} title="Add row above">
        <ArrowUp size={13} /><Plus size={10} className="-ml-1" />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().addColumnAfter().run()} title="Add column right">
        <ArrowRight size={13} /><Plus size={10} className="-ml-1" />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().addColumnBefore().run()} title="Add column left">
        <ArrowLeft size={13} /><Plus size={10} className="-ml-1" />
      </TBtn>

      <div className="w-px h-4 bg-[var(--color-border-strong)] mx-1" />

      <TBtn onClick={() => editor.chain().focus().toggleHeaderRow().run()} title="Toggle header row">
        <PanelTop size={13} />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().mergeCells().run()} title="Merge cells">
        <Merge size={13} />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().splitCell().run()} title="Split cell">
        <Split size={13} />
      </TBtn>

      {/* Cell background color */}
      <div className="relative">
        <input
          ref={cellColorRef}
          type="color"
          className="absolute opacity-0 w-0 h-0"
          onChange={e => editor.chain().focus().setCellAttribute('backgroundColor', e.target.value).run()}
        />
        <TBtn onClick={() => cellColorRef.current?.click()} title="Cell background color">
          <Paintbrush size={13} />
        </TBtn>
      </div>

      <div className="w-px h-4 bg-[var(--color-border-strong)] mx-1" />

      <TBtn onClick={() => editor.chain().focus().deleteRow().run()} title="Delete row" danger>
        <Rows3 size={13} /><Trash2 size={10} className="-ml-1" />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().deleteColumn().run()} title="Delete column" danger>
        <Columns3 size={13} /><Trash2 size={10} className="-ml-1" />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().deleteTable().run()} title="Delete table" danger>
        <Trash2 size={13} />
      </TBtn>
    </div>
  )
}

function TBtn({ onClick, children, title, danger }: {
  onClick: () => void
  children: React.ReactNode
  title: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`tool-btn flex items-center gap-0.5 p-1.5 ${danger ? 'text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]' : 'text-[var(--color-accent-text)] hover:bg-[var(--color-surface-tertiary)]'}`}
    >
      {children}
    </button>
  )
}
