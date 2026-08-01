import {
  Rows3, Columns3, Trash2, Plus, ArrowDown, ArrowUp, ArrowLeft, ArrowRight,
  Merge, Split,
} from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'

export function TableToolbar() {
  const { editor } = useEditorContext()

  if (!editor || !editor.isActive('table')) return null

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800 text-xs">
      <span className="text-blue-600 dark:text-blue-400 font-medium mr-2">Table</span>

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

      <div className="w-px h-4 bg-blue-200 mx-1" />

      <TBtn onClick={() => editor.chain().focus().mergeCells().run()} title="Merge cells">
        <Merge size={13} />
      </TBtn>
      <TBtn onClick={() => editor.chain().focus().splitCell().run()} title="Split cell">
        <Split size={13} />
      </TBtn>

      <div className="w-px h-4 bg-blue-200 mx-1" />

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
      className={`flex items-center gap-0.5 p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 ${danger ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30' : 'text-blue-700 dark:text-blue-400'}`}
    >
      {children}
    </button>
  )
}
