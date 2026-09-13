import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Underline as UnderlineIcon, AlignLeft, AlignCenter, AlignRight, Sparkles, CaseSensitive } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { useState } from 'react'

export function SelectionMenu() {
  const { editor, openAIPanel, submitAIRequest } = useEditorContext()
  const [showAIActions, setShowAIActions] = useState(false)
  const [showCaseMenu, setShowCaseMenu] = useState(false)

  if (!editor) return null

  const transformCase = (mode: 'upper' | 'lower' | 'title' | 'sentence') => {
    const { from, to } = editor.state.selection
    if (from === to) return
    const text = editor.state.doc.textBetween(from, to, ' ')
    let transformed: string
    switch (mode) {
      case 'upper': transformed = text.toUpperCase(); break
      case 'lower': transformed = text.toLowerCase(); break
      case 'title': transformed = text.replace(/\b\w/g, c => c.toUpperCase()); break
      case 'sentence': transformed = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase(); break
    }
    editor.chain().focus().command(({ tr }) => {
      tr.insertText(transformed, from, to)
      return true
    }).run()
    setShowCaseMenu(false)
  }

  const sendAIAction = (action: string) => {
    const { from, to } = editor.state.selection
    if (from === to) return
    const selectedText = editor.state.doc.textBetween(from, to, ' ')
    if (!selectedText) return
    setShowAIActions(false)
    openAIPanel()
    submitAIRequest({
      message: `${action}: "${selectedText}"`,
      source: 'selection',
      anchor: { from, to, cursor: from, selectedText },
    })
  }

  return (
    <BubbleMenu
      editor={editor}
      className="flex items-center gap-0.5 px-1.5 py-1.5 menu-surface relative"
    >
      <BubbleButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
      >
        <Bold size={15} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
      >
        <Italic size={15} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive('underline')}
      >
        <UnderlineIcon size={15} />
      </BubbleButton>

      <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

      <BubbleButton
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        active={editor.isActive({ textAlign: 'left' })}
      >
        <AlignLeft size={15} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        active={editor.isActive({ textAlign: 'center' })}
      >
        <AlignCenter size={15} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        active={editor.isActive({ textAlign: 'right' })}
      >
        <AlignRight size={15} />
      </BubbleButton>

      <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

      <div className="relative">
        <BubbleButton onClick={() => { setShowCaseMenu(!showCaseMenu); setShowAIActions(false) }}>
          <CaseSensitive size={15} />
        </BubbleButton>
        {showCaseMenu && (
          <div className="menu-surface anim-pop absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 menu-list min-w-[150px]">
            <AIAction label="UPPERCASE" onClick={() => transformCase('upper')} />
            <AIAction label="lowercase" onClick={() => transformCase('lower')} />
            <AIAction label="Title Case" onClick={() => transformCase('title')} />
            <AIAction label="Sentence case" onClick={() => transformCase('sentence')} />
          </div>
        )}
      </div>

      <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

      <div className="relative">
        <BubbleButton onClick={() => { setShowAIActions(!showAIActions); setShowCaseMenu(false) }}>
          <Sparkles size={15} />
        </BubbleButton>
        {showAIActions && (
          <div className="menu-surface anim-pop absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 menu-list min-w-[180px]">
            <AIAction label="Improve writing" onClick={() => sendAIAction('Improve the writing of this text')} />
            <AIAction label="Fix grammar" onClick={() => sendAIAction('Fix grammar and spelling in this text')} />
            <AIAction label="Make shorter" onClick={() => sendAIAction('Make this text more concise')} />
            <AIAction label="Make longer" onClick={() => sendAIAction('Expand and elaborate on this text')} />
            <AIAction label="Formal tone" onClick={() => sendAIAction('Rewrite this text in a formal tone')} />
            <AIAction label="Casual tone" onClick={() => sendAIAction('Rewrite this text in a casual tone')} />
            <AIAction label="Translate to English" onClick={() => sendAIAction('Translate this text to English')} />
            <AIAction label="Translate to Chinese" onClick={() => sendAIAction('Translate this text to Chinese')} />
            <AIAction label="Summarize" onClick={() => sendAIAction('Summarize this text in one sentence')} />
            <AIAction label="Explain" onClick={() => sendAIAction('Explain this text in simpler terms')} />
          </div>
        )}
      </div>
    </BubbleMenu>
  )
}

function BubbleButton({ onClick, active, children }: {
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`p-1.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors ${active ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-accent-text)]' : ''}`}
    >
      {children}
    </button>
  )
}

function AIAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="menu-item">
      {label}
    </button>
  )
}
