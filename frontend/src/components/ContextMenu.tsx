import { useState, useEffect, useRef } from 'react'
import { useEditorContext } from '../context/EditorContext'

interface ContextMenuState {
  x: number
  y: number
  visible: boolean
  inTable: boolean
  hasSelection: boolean
}

export function ContextMenu() {
  const { editor } = useEditorContext()
  const [menu, setMenu] = useState<ContextMenuState>({ x: 0, y: 0, visible: false, inTable: false, hasSelection: false })
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Only trigger inside the editor area
      const editorEl = document.querySelector('.ProseMirror')
      if (!editorEl || !editorEl.contains(e.target as Node)) return

      e.preventDefault()
      const inTable = editor?.isActive('table') || false
      const { from, to } = editor?.state.selection || { from: 0, to: 0 }
      setMenu({ x: e.clientX, y: e.clientY, visible: true, inTable, hasSelection: from !== to })
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
      className="menu-surface anim-pop fixed z-50 menu-list min-w-[200px]"
      style={{ left: menu.x, top: menu.y }}
    >
      <MenuItem onClick={() => document.execCommand('copy')} disabled={!menu.hasSelection}>Copy</MenuItem>
      <MenuItem onClick={() => document.execCommand('cut')} disabled={!menu.hasSelection}>Cut</MenuItem>
      <MenuItem onClick={() => document.execCommand('paste')}>Paste</MenuItem>
      <MenuItem onClick={() => editor.commands.selectAll()}>Select All</MenuItem>
      <MenuDivider />
      {menu.hasSelection && (
        <>
          <MenuItem onClick={() => editor.chain().focus().toggleBold().run()}>Bold</MenuItem>
          <MenuItem onClick={() => editor.chain().focus().toggleItalic().run()}>Italic</MenuItem>
          <MenuItem onClick={() => editor.chain().focus().toggleUnderline().run()}>Underline</MenuItem>
          <MenuDivider />
        </>
      )}
      <MenuItem onClick={() => window.dispatchEvent(new CustomEvent('editor:open-find-replace'))}>Find & Replace</MenuItem>
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

function MenuItem({ onClick, children, danger, disabled }: { onClick: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`menu-item ${danger ? 'danger' : ''}`}
    >
      {children}
    </button>
  )
}

function MenuDivider() {
  return <div className="menu-separator" />
}
