import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Underline as UnderlineIcon, AlignLeft, AlignCenter, AlignRight, Sparkles } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { useState } from 'react'
import { apiUrl } from '../utils/api'

export function SelectionMenu() {
  const { editor, addMessage, setIsSending } = useEditorContext()
  const [showAIActions, setShowAIActions] = useState(false)

  if (!editor) return null

  const getSelectedText = () => {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to, ' ')
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
      className="flex items-center gap-0.5 px-1 py-0.5 bg-gray-900 rounded-lg shadow-xl relative"
    >
      <BubbleButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
      >
        <Bold size={14} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
      >
        <Italic size={14} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive('underline')}
      >
        <UnderlineIcon size={14} />
      </BubbleButton>

      <div className="w-px h-4 bg-gray-600 mx-0.5" />

      <BubbleButton
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        active={editor.isActive({ textAlign: 'left' })}
      >
        <AlignLeft size={14} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        active={editor.isActive({ textAlign: 'center' })}
      >
        <AlignCenter size={14} />
      </BubbleButton>
      <BubbleButton
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        active={editor.isActive({ textAlign: 'right' })}
      >
        <AlignRight size={14} />
      </BubbleButton>

      <div className="w-px h-4 bg-gray-600 mx-0.5" />

      <div className="relative">
        <BubbleButton onClick={() => setShowAIActions(!showAIActions)}>
          <Sparkles size={14} />
        </BubbleButton>
        {showAIActions && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-xl py-1 min-w-[140px] text-xs">
            <AIAction label="Improve writing" onClick={() => sendAIAction('Improve the writing of this text')} />
            <AIAction label="Fix grammar" onClick={() => sendAIAction('Fix grammar and spelling in this text')} />
            <AIAction label="Make shorter" onClick={() => sendAIAction('Make this text more concise')} />
            <AIAction label="Make longer" onClick={() => sendAIAction('Expand and elaborate on this text')} />
            <AIAction label="Formal tone" onClick={() => sendAIAction('Rewrite this text in a formal tone')} />
            <AIAction label="Casual tone" onClick={() => sendAIAction('Rewrite this text in a casual tone')} />
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
      className={`p-1.5 rounded text-white hover:bg-gray-700 ${active ? 'bg-gray-700' : ''}`}
    >
      {children}
    </button>
  )
}

function AIAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
    >
      {label}
    </button>
  )
}
