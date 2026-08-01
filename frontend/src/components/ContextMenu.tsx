import { useState, useEffect, useRef } from 'react'
import { useEditorContext } from '../context/EditorContext'

interface ContextMenuState {
  x: number
  y: number
  visible: boolean
  inTable: boolean
}

export function ContextMenu() {
  const { editor } = useEditorContext()
  const [menu, setMenu] = useState<ContextMenuState>({ x: 0, y: 0, visible: false, inTable: false })
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Only trigger inside the editor area
      const editorEl = document.querySelector('.ProseMirror')
      if (!editorEl || !editorEl.contains(e.target as Node)) return

      e.preventDefault()
      const inTable = editor?.isActive('table') || false
      setMenu({ x: e.clientX, y: e.clientY, visible: true, inTable })
    }

    const handleClick = () => setMenu(prev => ({ ...prev, visible: false }))

    document.addEventListener('contextmenu', handleContextMenu)
    document.addEventListener('click', handleClick)
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu)
      document.removeEventListener('click', handleClick)
    }
  }, [editor])

  if (!menu.visible || !editor) return null

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[160px]"
      style={{ left: menu.x, top: menu.y }}
    >
      <MenuItem onClick={() => editor.chain().focus().toggleBold().run()}>Bold</MenuItem>
      <MenuItem onClick={() => editor.chain().focus().toggleItalic().run()}>Italic</MenuItem>
      <MenuItem onClick={() => editor.chain().focus().toggleUnderline().run()}>Underline</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => document.execCommand('copy')}>Copy</MenuItem>
      <MenuItem onClick={() => document.execCommand('cut')}>Cut</MenuItem>
      <MenuItem onClick={() => document.execCommand('paste')}>Paste</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>Insert Horizontal Rule</MenuItem>
      <MenuItem onClick={() => editor.chain().focus().setPageBreak().run()}>Insert Page Break</MenuItem>

      {menu.inTable && (
        <>
          <MenuDivider />
          <MenuItem onClick={() => editor.chain().focus().addRowAfter().run()}>Add Row Below</MenuItem>
          <MenuItem onClick={() => editor.chain().focus().addRowBefore().run()}>Add Row Above</MenuItem>
          <MenuItem onClick={() => editor.chain().focus().addColumnAfter().run()}>Add Column Right</MenuItem>
          <MenuItem onClick={() => editor.chain().focus().addColumnBefore().run()}>Add Column Left</MenuItem>
          <MenuDivider />
          <MenuItem onClick={() => editor.chain().focus().deleteRow().run()} danger>Delete Row</MenuItem>
          <MenuItem onClick={() => editor.chain().focus().deleteColumn().run()} danger>Delete Column</MenuItem>
          <MenuItem onClick={() => editor.chain().focus().deleteTable().run()} danger>Delete Table</MenuItem>
        </>
      )}
    </div>
  )
}

function MenuItem({ onClick, children, danger }: { onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 ${danger ? 'text-red-600' : 'text-gray-700 dark:text-gray-200'}`}
    >
      {children}
    </button>
  )
}

function MenuDivider() {
  return <div className="h-px bg-gray-200 dark:bg-gray-700 my-1" />
}
