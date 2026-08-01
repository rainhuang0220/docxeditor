import { useState, useRef, useEffect } from 'react'
import { Send, X, Check, XCircle, Trash2 } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { apiUrl } from '../utils/api'
import { DiffView } from './DiffView'

interface PendingOperation {
  operations: any[]
  preview?: string
  oldContent?: string
  newContent?: string
}

export function AIPanel() {
  const { messages, addMessage, updateMessage, finalizeMessage, clearMessages, isAIPanelOpen, toggleAIPanel, editor, isSending, setIsSending } = useEditorContext()
  const [input, setInput] = useState('')
  const [pendingOp, setPendingOp] = useState<PendingOperation | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (isAIPanelOpen) {
      fetch(apiUrl('/api/config'))
        .then(res => res.json())
        .then(data => setHasApiKey(data.has_key))
        .catch(() => setHasApiKey(null))
    }
  }, [isAIPanelOpen])

  const handleSend = async () => {
    if (!input.trim() || isSending) return
    const userMsg = input.trim()
    setInput('')
    addMessage('user', userMsg)
    setIsSending(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const documentContent = editor?.getHTML() || ''
      // Include selected text context if any
      const { from, to } = editor?.state.selection || { from: 0, to: 0 }
      const selectedText = editor && from !== to
        ? editor.state.doc.textBetween(from, to, ' ')
        : ''
      const res = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          document: documentContent,
          selection: selectedText,
          history: messages.slice(-10),
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        // Fallback to non-streaming endpoint
        const fallbackRes = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userMsg,
            document: documentContent,
            selection: selectedText,
            history: messages.slice(-10),
          }),
        })
        const data = await fallbackRes.json()
        if (data.reply) addMessage('assistant', data.reply)
        if (data.operations?.length > 0) {
          if (data.requires_confirmation) {
            setPendingOp({ operations: data.operations, preview: data.preview })
          } else {
            applyOperations(data.operations)
          }
        }
        return
      }

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let streamedReply = ''
      let lineBuffer = ''
      // Show a streaming indicator — final reply replaces it when done
      const streamMsgId = addMessage('assistant', '...', true)

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split('\n')
          // Keep the last incomplete line in the buffer
          lineBuffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6)
            try {
              const event = JSON.parse(payload)
              if (event.type === 'chunk') {
                streamedReply += event.content
                updateMessage(streamMsgId, streamedReply)
              } else if (event.type === 'done') {
                const result = event.result
                const displayReply = result.reply || (result.operations?.length > 0 ? 'Done.' : 'No changes needed.')
                finalizeMessage(streamMsgId, displayReply)
                if (result.operations?.length > 0) {
                  if (result.requires_confirmation) {
                    // Generate diff preview for replace_content operations
                    const currentContent = editor?.state.doc.textContent || ''
                    let newContent = ''
                    for (const op of result.operations) {
                      if (op.type === 'replace_content') {
                        // Strip HTML to get plaintext for diff
                        const tmp = document.createElement('div')
                        tmp.innerHTML = op.content
                        newContent = tmp.textContent || ''
                      }
                    }
                    setPendingOp({
                      operations: result.operations,
                      preview: result.preview,
                      oldContent: newContent ? currentContent : undefined,
                      newContent: newContent || undefined,
                    })
                  } else {
                    applyOperations(result.operations)
                  }
                }
              } else if (event.type === 'error') {
                finalizeMessage(streamMsgId, `Error: ${event.content}`)
              }
            } catch { /* skip malformed lines */ }
          }
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        addMessage('assistant', 'Request cancelled.')
      } else {
        addMessage('assistant', 'Failed to connect to AI service. Make sure the backend is running.')
      }
    } finally {
      abortRef.current = null
      setIsSending(false)
    }
  }

  const applyOperations = (operations: any[]) => {
    if (!editor) return
    for (const op of operations) {
      applyOperation(editor, op)
    }
  }

  const acceptPending = () => {
    if (pendingOp) {
      applyOperations(pendingOp.operations)
      addMessage('assistant', 'Changes applied.')
      setPendingOp(null)
    }
  }

  const rejectPending = () => {
    addMessage('assistant', 'Changes rejected.')
    setPendingOp(null)
  }

  if (!isAIPanelOpen) return null

  return (
    <div className="w-80 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-100">AI Assistant</h3>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button onClick={clearMessages} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Clear chat">
              <Trash2 size={14} />
            </button>
          )}
          <button onClick={toggleAIPanel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3" role="log" aria-live="polite" aria-label="Chat messages">
        {hasApiKey === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
            <p className="font-medium mb-1">No API key configured</p>
            <p>Click the key icon in the toolbar to set your OpenAI or Anthropic API key.</p>
          </div>
        )}
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-8">
            <p>Ask me to help edit your document.</p>
            <p className="mt-2 text-xs">Examples:</p>
            <p className="text-xs text-gray-500 mt-1">"Make the title bold and centered"</p>
            <p className="text-xs text-gray-500">"Rewrite paragraph 2 in formal tone"</p>
            <p className="text-xs text-gray-500">"Add a table with 3 columns"</p>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`text-sm ${msg.role === 'user' ? 'text-right' : ''}`}>
            <div className={`inline-block px-3 py-2 rounded-lg max-w-[90%] whitespace-pre-wrap text-left ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
            } ${msg.streaming ? 'streaming-cursor' : ''}`}>
              {msg.content || '...'}
            </div>
          </div>
        ))}

        {pendingOp && (
          <div className="border border-yellow-300 bg-yellow-50 rounded-lg p-3 text-sm">
            <p className="font-medium text-yellow-800 mb-2">Pending changes:</p>
            {pendingOp.oldContent && pendingOp.newContent && (
              <DiffView oldText={pendingOp.oldContent} newText={pendingOp.newContent} />
            )}
            {pendingOp.preview && !pendingOp.oldContent && (
              <pre className="text-xs bg-white border rounded p-2 mb-2 overflow-x-auto max-h-40 overflow-y-auto">
                {pendingOp.preview}
              </pre>
            )}
            <div className="flex gap-2 mt-2">
              <button
                onClick={acceptPending}
                className="flex items-center gap-1 px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
              >
                <Check size={12} /> Accept
              </button>
              <button
                onClick={rejectPending}
                className="flex items-center gap-1 px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
              >
                <XCircle size={12} /> Reject
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-gray-200 dark:border-gray-700">
        {/* Quick suggestion chips */}
        {messages.length === 0 && !isSending && (
          <div className="flex flex-wrap gap-1 mb-2">
            {['Summarize document', 'Fix grammar', 'Add a conclusion', 'Make more formal'].map(suggestion => (
              <button
                key={suggestion}
                onClick={() => { setInput(suggestion); }}
                className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600 border border-gray-200 dark:border-gray-600"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !isSending) handleSend(); if (e.key === 'Escape') toggleAIPanel() }}
            placeholder="Ask AI to edit..."
            aria-label="Message to AI assistant"
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
          />
          {isSending ? (
            <button
              onClick={() => abortRef.current?.abort()}
              aria-label="Cancel request"
              className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
            >
              <X size={16} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              aria-label="Send message"
              className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function applyOperation(editor: any, op: any) {
  switch (op.type) {
    case 'replace_content':
      editor.commands.setContent(op.content)
      break
    case 'insert_at_end':
      editor.commands.focus('end')
      editor.commands.insertContent(op.content)
      break
    case 'insert_at_cursor':
      editor.commands.insertContent(op.content)
      break
    case 'insert_after_paragraph': {
      // Insert content after a specific paragraph index
      const targetIdx = op.paragraph_index ?? 0
      let currentIdx = 0
      let insertPos = editor.state.doc.content.size
      editor.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'paragraph' || node.type.name === 'heading') {
          if (currentIdx === targetIdx) {
            insertPos = pos + node.nodeSize
          }
          currentIdx++
        }
      })
      editor.chain().focus().insertContentAt(insertPos, op.content).run()
      break
    }
    case 'replace_paragraph': {
      // Replace content of a specific paragraph by index
      const targetIdx = op.paragraph_index ?? 0
      let currentIdx = 0
      editor.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'paragraph' || node.type.name === 'heading') {
          if (currentIdx === targetIdx) {
            const from = pos
            const to = pos + node.nodeSize
            editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, op.content).run()
          }
          currentIdx++
        }
      })
      break
    }
    case 'delete_paragraph': {
      // Delete a specific paragraph by index
      const targetIdx = op.paragraph_index ?? 0
      let currentIdx = 0
      editor.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'paragraph' || node.type.name === 'heading') {
          if (currentIdx === targetIdx) {
            editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run()
          }
          currentIdx++
        }
      })
      break
    }
    case 'set_heading': {
      const level = op.level || 1
      editor.chain().focus().toggleHeading({ level }).run()
      break
    }
    case 'set_bold':
      editor.chain().focus().toggleBold().run()
      break
    case 'set_italic':
      editor.chain().focus().toggleItalic().run()
      break
    case 'set_underline':
      editor.chain().focus().toggleUnderline().run()
      break
    case 'set_strikethrough':
      editor.chain().focus().toggleStrike().run()
      break
    case 'set_highlight':
      editor.chain().focus().toggleHighlight().run()
      break
    case 'set_link':
      if (op.href) editor.chain().focus().setLink({ href: op.href }).run()
      break
    case 'set_align':
      editor.chain().focus().setTextAlign(op.alignment).run()
      break
    case 'set_font_family':
      editor.chain().focus().setFontFamily(op.family).run()
      break
    case 'set_font_size':
      editor.chain().focus().setFontSize(op.size).run()
      break
    case 'set_color':
      editor.chain().focus().setColor(op.color).run()
      break
    case 'insert_table':
      editor.chain().focus().insertTable({
        rows: op.rows || 3,
        cols: op.cols || 3,
        withHeaderRow: true,
      }).run()
      break
    case 'insert_image':
      if (op.src) {
        editor.chain().focus().setImage({ src: op.src, alt: op.alt || '' }).run()
      }
      break
    case 'insert_horizontal_rule':
      editor.chain().focus().setHorizontalRule().run()
      break
    case 'insert_blockquote':
      editor.chain().focus().insertContent(`<blockquote><p>${op.content || ''}</p></blockquote>`).run()
      break
    case 'insert_list': {
      const items = op.items || []
      const listType = op.list_type === 'ordered' ? 'ol' : 'ul'
      const html = `<${listType}>${items.map((i: string) => `<li><p>${i}</p></li>`).join('')}</${listType}>`
      editor.chain().focus().insertContent(html).run()
      break
    }
    case 'insert_code_block':
      editor.chain().focus().toggleCodeBlock().run()
      if (op.content) {
        editor.commands.insertContent(op.content)
      }
      break
    case 'replace_selection': {
      const { from, to } = editor.state.selection
      if (from !== to) {
        editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, op.content).run()
      } else {
        editor.commands.insertContent(op.content)
      }
      break
    }
    default:
      console.warn('Unknown operation:', op.type)
      break
  }
}
