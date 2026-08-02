import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Underline as UnderlineIcon, AlignLeft, AlignCenter, AlignRight, Sparkles, CaseSensitive } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { useState } from 'react'
import { apiUrl } from '../utils/api'

export function SelectionMenu() {
  const { editor, addMessage, setIsSending } = useEditorContext()
  const [showAIActions, setShowAIActions] = useState(false)
  const [showCaseMenu, setShowCaseMenu] = useState(false)

  if (!editor) return null

  const getSelectedText = () => {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to, ' ')
  }

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

  const sendAIAction = async (action: string) => {
    const selected = getSelectedText()
    if (!selected) return
    setShowAIActions(false)
    const prompt = `${action}: "${selected}"`
    addMessage('user', prompt)
    setIsSending(true)
    try {
      const res = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: prompt,
          document: editor.getHTML(),
          selection: selected,
          history: [],
        }),
      })
      if (!res.ok) return
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let full = ''
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          full += decoder.decode(value, { stream: true })
        }
      }
      // Parse final result from SSE
      const lines = full.split('\n')
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.type === 'done' && event.result) {
            if (event.result.reply) addMessage('assistant', event.result.reply)
            if (event.result.operations?.length > 0) {
              for (const op of event.result.operations) {
                if (op.type === 'replace_content') {
                  editor.commands.setContent(op.content)
                } else if (op.type === 'replace_selection' || op.type === 'insert_at_cursor') {
                  // Replace current selection with the new content
                  const { from, to } = editor.state.selection
                  if (from !== to) {
                    editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, op.content).run()
                  } else {
                    editor.commands.insertContent(op.content)
                  }
                } else if (op.type === 'replace_paragraph' || op.type === 'insert_at_end') {
                  editor.commands.insertContent(op.content)
                }
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    finally { setIsSending(false) }
  }

  return (
    <BubbleMenu
      editor={editor}
      className="flex items-center gap-0.5 px-1.5 py-1.5 bg-[#1c1c1e] rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.22),0_2px_8px_rgba(0,0,0,0.14)] border border-white/10 relative"
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

      <div className="w-px h-4 bg-white/20 mx-0.5" />

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

      <div className="w-px h-4 bg-white/20 mx-0.5" />

      {/* Case transform */}
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

      <div className="w-px h-4 bg-white/20 mx-0.5" />

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
      className={`p-1.5 rounded-md text-white/75 hover:text-white hover:bg-white/10 transition-colors ${active ? 'bg-white/15 text-white' : ''}`}
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
