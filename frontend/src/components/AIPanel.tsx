import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowUp, X, Check, XCircle, Trash2, Square, Sparkles, Loader2 } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { apiUrl } from '../utils/api'
import Markdown from 'react-markdown'

interface Activity {
  label: string
  detail?: string
}

interface ReviewState {
  snapshot: string
  summary: string[]
}

interface LiveStream {
  mode: 'replace' | 'append'
  base: string
  buffer: string
  flushTimer: number | null
}

/** Tools whose content is streamed live into the editor while the AI writes. */
const LIVE_WRITE_TOOLS = new Set(['replace_content', 'insert_at_end'])

function toolStartLabel(name: string): string {
  switch (name) {
    case 'read_blocks': return 'Reading document'
    case 'replace_content': return 'Writing document'
    case 'insert_at_end': return 'Appending to document'
    case 'insert_at_cursor': return 'Inserting content'
    case 'replace_paragraph': return 'Editing block'
    case 'insert_after_paragraph': return 'Inserting block'
    case 'delete_paragraph': return 'Removing block'
    case 'replace_selection': return 'Rewriting selection'
    case 'format_selection': return 'Formatting'
    case 'insert_table': return 'Inserting table'
    case 'insert_list': return 'Inserting list'
    case 'insert_image': return 'Inserting image'
    default: return 'Editing document'
  }
}

function opSummary(op: any): string {
  const blockNo = typeof op.paragraph_index === 'number' ? ` ${op.paragraph_index + 1}` : ''
  switch (op.type) {
    case 'replace_content': return 'Rewrote the entire document'
    case 'replace_paragraph': return `Edited block${blockNo}`
    case 'insert_after_paragraph': return `Inserted content after block${blockNo}`
    case 'delete_paragraph': return `Deleted block${blockNo}`
    case 'insert_at_end': return 'Appended content at the end'
    case 'insert_at_cursor': return 'Inserted content at the cursor'
    case 'replace_selection': return 'Rewrote the selected text'
    case 'insert_table': return 'Inserted a table'
    case 'insert_list': return 'Inserted a list'
    case 'insert_image': return 'Inserted an image'
    case 'set_heading': return `Set heading level ${op.level ?? 1}`
    case 'set_align': return `Aligned text ${op.alignment ?? ''}`
    default: return String(op.type || 'edit').replace(/^set_/, '').replace(/_/g, ' ')
  }
}

function formatChars(n: number): string {
  return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`
}

export function AIPanel() {
  const { messages, addMessage, updateMessage, finalizeMessage, clearMessages, isAIPanelOpen, toggleAIPanel, editor, isSending, setIsSending } = useEditorContext()
  const [input, setInput] = useState('')
  const [review, setReview] = useState<ReviewState | null>(null)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const liveRef = useRef<LiveStream | null>(null)
  const snapshotRef = useRef<string | null>(null)
  const charsRef = useRef(0)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activity, review])

  useEffect(() => {
    if (isAIPanelOpen) {
      fetch(apiUrl('/api/config'))
        .then(res => res.json())
        .then(data => setHasApiKey(data.has_key))
        .catch(() => setHasApiKey(null))
    }
  }, [isAIPanelOpen])

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [input])

  // Elapsed-seconds counter for the activity indicator
  useEffect(() => {
    if (!isSending) { setElapsed(0); return }
    const t0 = Date.now()
    const iv = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => window.clearInterval(iv)
  }, [isSending])

  /** Take one document snapshot per request (for reject/restore) and record a version. */
  const ensureSnapshot = useCallback(() => {
    if (snapshotRef.current !== null || !editor) return
    snapshotRef.current = editor.getHTML()
    window.dispatchEvent(new CustomEvent('editor:save-version', { detail: { description: 'Before AI edit' } }))
  }, [editor])

  const flushLive = useCallback(() => {
    const live = liveRef.current
    if (!live || !editor) return
    live.flushTimer = null
    // Strip a trailing incomplete tag (e.g. "<h2 sty") so it never renders as raw text
    const html = (live.base + live.buffer).replace(/<[^>]*$/, '')
    editor.commands.setContent(html, { emitUpdate: false, parseOptions: { preserveWhitespace: true } })
    const scroller = editor.view.dom.closest('.overflow-y-auto')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [editor])

  const scheduleFlush = useCallback(() => {
    const live = liveRef.current
    if (!live || live.flushTimer !== null) return
    live.flushTimer = window.setTimeout(flushLive, 120)
  }, [flushLive])

  /** Stop live-write timers and streaming UI state (does not touch content). */
  const endStreamingUI = useCallback(() => {
    const live = liveRef.current
    if (live?.flushTimer) window.clearTimeout(live.flushTimer)
    liveRef.current = null
    document.body.classList.remove('ai-writing')
    editor?.setEditable(true)
  }, [editor])

  /** Apply the final operations and open the review bar when confirmation is needed. */
  const finishResult = useCallback((result: any, streamMsgId: string | null) => {
    const ops: any[] = result.operations || []
    const warnings: string[] = result.warnings || []

    let displayReply = result.reply || (ops.length > 0 ? 'Done.' : 'No changes were needed.')
    if (warnings.length > 0) {
      displayReply += '\n\n' + warnings.map(w => `⚠️ ${w}`).join('\n\n')
    }
    if (streamMsgId) finalizeMessage(streamMsgId, displayReply)
    else addMessage('assistant', displayReply)

    if (!editor) return
    const wasLive = liveRef.current !== null
    endStreamingUI()

    if (ops.length === 0) {
      // Streamed something but every operation was discarded (e.g. truncated) — restore
      if (wasLive && snapshotRef.current !== null) {
        editor.commands.setContent(snapshotRef.current, { parseOptions: { preserveWhitespace: true } })
      }
      snapshotRef.current = null
      return
    }

    ensureSnapshot()
    const snapshot = snapshotRef.current as string

    const singleFullRewrite = ops.length === 1 && ops[0].type === 'replace_content'
    if (singleFullRewrite) {
      // The live preview already shows ~this content; set the exact final version
      editor.commands.setContent(ops[0].content || '', { parseOptions: { preserveWhitespace: true } })
    } else {
      // Always rebuild from the pre-edit snapshot, then apply every op.
      // This keeps block indices valid even if a live preview or a partial
      // earlier apply left the editor mid-state.
      editor.commands.setContent(snapshot, { emitUpdate: false, parseOptions: { preserveWhitespace: true } })
      applyOperationBatch(editor, ops)
    }

    if (result.requires_confirmation) {
      setReview({ snapshot, summary: ops.map(opSummary) })
    } else {
      snapshotRef.current = null
    }
  }, [editor, addMessage, finalizeMessage, endStreamingUI, ensureSnapshot])

  const handleSendMessage = useCallback(async (message: string) => {
    if (!message.trim() || isSending) return
    setInput('')
    // Starting a new request implicitly keeps any still-open review
    setReview(null)
    snapshotRef.current = null
    charsRef.current = 0
    addMessage('user', message)
    setIsSending(true)
    setActivity({ label: 'Sending request' })

    const controller = new AbortController()
    abortRef.current = controller
    let streamMsgId: string | null = null

    try {
      const documentContent = editor?.getHTML() || ''
      const { from, to } = editor?.state.selection || { from: 0, to: 0 }
      const selectedText = editor && from !== to
        ? editor.state.doc.textBetween(from, to, ' ')
        : ''
      const payload = JSON.stringify({
        message,
        document: documentContent,
        selection: selectedText,
        history: messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
      })

      const res = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const fallbackRes = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
        })
        const data = await fallbackRes.json()
        finishResult(data, null)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let streamedReply = ''
      let lineBuffer = ''
      streamMsgId = addMessage('assistant', '', true)

      const handleSseLine = (line: string) => {
        if (!line.startsWith('data: ')) return
        let event: any
        try {
          event = JSON.parse(line.slice(6))
        } catch { return }

        switch (event.type) {
          case 'status':
            setActivity({
              label: event.stage === 'reading'
                ? 'Reading document'
                : event.stage === 'checking'
                  ? 'Verifying coverage'
                  : 'Thinking',
            })
            break
          case 'thinking':
            setActivity({ label: 'Thinking' })
            break
          case 'chunk':
            streamedReply += event.content
            updateMessage(streamMsgId!, streamedReply)
            setActivity(null)
            break
          case 'tool_start': {
            setActivity({ label: toolStartLabel(event.name) })
            ensureSnapshot()
            if (LIVE_WRITE_TOOLS.has(event.name) && editor && !liveRef.current) {
              liveRef.current = {
                mode: event.name === 'replace_content' ? 'replace' : 'append',
                base: event.name === 'insert_at_end' ? editor.getHTML() : '',
                buffer: '',
                flushTimer: null,
              }
              editor.setEditable(false)
              document.body.classList.add('ai-writing')
            }
            break
          }
          case 'tool_delta': {
            charsRef.current += String(event.content || '').length
            const live = liveRef.current
            if (live && LIVE_WRITE_TOOLS.has(event.name)) {
              live.buffer += event.content
              scheduleFlush()
            }
            setActivity({ label: toolStartLabel(event.name), detail: formatChars(charsRef.current) })
            break
          }
          case 'tool_progress':
            if (event.chars > charsRef.current) charsRef.current = event.chars
            setActivity(prev => ({ label: prev?.label || 'Working', detail: formatChars(charsRef.current) }))
            break
          case 'done':
            finishResult(event.result || {}, streamMsgId)
            break
          case 'error': {
            const wasLive = liveRef.current !== null
            endStreamingUI()
            if (wasLive && editor && snapshotRef.current !== null) {
              editor.commands.setContent(snapshotRef.current, { parseOptions: { preserveWhitespace: true } })
            }
            snapshotRef.current = null
            finalizeMessage(streamMsgId!, `Error: ${event.content}`)
            break
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (value) {
          lineBuffer += decoder.decode(value, { stream: true })
        }
        const lines = lineBuffer.split('\n')
        if (!done) {
          // Keep the trailing partial line — SSE events end with \n.
          lineBuffer = lines.pop() || ''
        } else {
          // Stream ended: flush any final event that lacked a trailing newline.
          lineBuffer = ''
        }
        for (const line of lines) handleSseLine(line)
        if (done) break
      }
    } catch (e) {
      const wasLive = liveRef.current !== null
      endStreamingUI()
      if (wasLive && editor && snapshotRef.current !== null) {
        editor.commands.setContent(snapshotRef.current, { parseOptions: { preserveWhitespace: true } })
        snapshotRef.current = null
      }
      const failText = e instanceof DOMException && e.name === 'AbortError'
        ? (wasLive ? 'Request cancelled — document restored.' : 'Request cancelled.')
        : 'Failed to connect to AI service. Make sure the backend is running.'
      if (streamMsgId) finalizeMessage(streamMsgId, failText)
      else addMessage('assistant', failText)
    } finally {
      abortRef.current = null
      setIsSending(false)
      setActivity(null)
      endStreamingUI()
    }
  }, [editor, isSending, messages, addMessage, updateMessage, finalizeMessage, setIsSending, ensureSnapshot, scheduleFlush, endStreamingUI, finishResult])

  const handleSend = () => handleSendMessage(input.trim())

  const acceptReview = () => {
    setReview(null)
    snapshotRef.current = null
    window.dispatchEvent(new CustomEvent('editor:save-version', { detail: { description: 'AI edit accepted' } }))
  }

  const rejectReview = () => {
    if (editor && review) {
      editor.commands.setContent(review.snapshot, { parseOptions: { preserveWhitespace: true } })
    }
    setReview(null)
    snapshotRef.current = null
    addMessage('assistant', 'Changes rejected — the document was restored.')
  }

  if (!isAIPanelOpen) return null

  return (
    <div className="ai-panel chrome-panel w-[420px] border-l border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col panel-slide">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border-light)]">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-[var(--color-text-primary)] flex items-center justify-center">
            <Sparkles size={12} className="text-[var(--color-surface)]" />
          </div>
          <span className="text-[14px] font-semibold text-[var(--color-text-primary)] tracking-[-0.02em]">Assistant</span>
          <span className="eyebrow mt-px">AI</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button onClick={clearMessages} className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors" title="Clear chat">
              <Trash2 size={14} />
            </button>
          )}
          <button onClick={toggleAIPanel} className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5" role="log" aria-live="polite" aria-label="Chat messages">
        {hasApiKey === false && (
          <button
            onClick={() => window.dispatchEvent(new Event('open-ai-config'))}
            className="mb-5 w-full text-left rounded-lg bg-amber-500/[0.07] border border-amber-500/25 px-4 py-3.5 text-[14px] text-amber-700 dark:text-amber-400 leading-relaxed hover:bg-amber-500/[0.12] transition-colors cursor-pointer"
          >
            <p className="font-semibold mb-1 tracking-[-0.01em]">No API key configured</p>
            <p className="text-[13px] opacity-75">Click here to set your provider, API key, model and base URL.</p>
          </button>
        )}

        {messages.length === 0 && (
          <div className="mt-20 text-center px-4">
            <div className="w-11 h-11 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-5">
              <Sparkles size={20} className="text-[var(--color-primary)]" />
            </div>
            <p className="text-[17px] font-semibold text-[var(--color-text-primary)] tracking-[-0.03em]">What can I help with?</p>
            <p className="text-[14px] text-[var(--color-text-tertiary)] mt-2.5 leading-relaxed">Ask me to edit, format, or rewrite<br/>any part of your document.</p>
          </div>
        )}

        {/* Message list */}
        <div className="space-y-6">
          {messages.map(msg => (
            <div key={msg.id} className="ai-msg-item">
              {msg.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="max-w-[88%] rounded-lg rounded-br-[2px] bg-[var(--color-primary)] px-3.5 py-2.5 text-[14px] text-white leading-[1.6] tracking-[-0.01em] overflow-wrap-anywhere">
                    <span className="whitespace-pre-wrap">{msg.content || '...'}</span>
                  </div>
                </div>
              ) : (
                (msg.content || !msg.streaming) && (
                  <div className={`ai-prose text-[14px] leading-[1.7] text-[var(--color-text-primary)] tracking-[-0.01em] overflow-wrap-anywhere ${msg.streaming ? 'ai-streaming' : ''}`}>
                    <Markdown>{msg.content}</Markdown>
                  </div>
                )
              )}
            </div>
          ))}
        </div>

        {/* Live activity indicator (Claude-style) */}
        {isSending && (
          <div className="ai-activity mt-5 ai-msg-item" aria-live="polite">
            <Loader2 size={13} className="animate-spin text-[var(--color-primary)] shrink-0" />
            <span className="ai-activity-label">{activity?.label ?? 'Waiting for model'}…</span>
            {activity?.detail && (
              <span className="text-[12px] font-[var(--font-mono)] text-[var(--color-text-muted)] tabular-nums">{activity.detail}</span>
            )}
            {elapsed > 0 && (
              <span className="text-[12px] font-[var(--font-mono)] text-[var(--color-text-muted)] tabular-nums">· {elapsed}s</span>
            )}
          </div>
        )}

        {/* Review bar: changes are already applied, accept keeps them, reject restores */}
        {review && !isSending && (
          <div className="mt-5 border border-[var(--color-primary)]/20 bg-[var(--color-primary-light)] rounded-lg p-4 ai-msg-item">
            <p className="text-[13px] font-semibold text-[var(--color-primary)] tracking-[-0.01em]">Changes applied to the document</p>
            <ul className="mt-2.5 space-y-1.5">
              {review.summary.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-[12.5px] text-[var(--color-text-secondary)] leading-snug">
                  <Check size={13} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-[var(--color-text-tertiary)] mt-2.5">Review the result on the left. Reject restores the previous version.</p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={acceptReview}
                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-[var(--color-primary)] text-white rounded-md text-[13px] font-medium hover:bg-[var(--color-primary-hover)] transition-colors"
              >
                <Check size={13} /> Accept
              </button>
              <button
                onClick={rejectReview}
                className="flex items-center gap-1.5 px-3.5 py-1.5 border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] rounded-md text-[13px] font-medium hover:bg-[var(--color-surface-secondary)] transition-colors"
              >
                <XCircle size={13} /> Reject & restore
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-4 pb-4 pt-3 border-t border-[var(--color-border-light)]">
        {/* Quick suggestions */}
        {messages.length === 0 && !isSending && (
          <div className="flex flex-wrap gap-1.5 mb-3.5">
            {['Summarize', 'Fix grammar', 'Format headings', 'Make formal'].map(suggestion => (
              <button
                key={suggestion}
                onClick={() => handleSendMessage(suggestion)}
                className="px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-text-secondary)] rounded-md border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors bg-transparent"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {/* Textarea + send button */}
        <div className="relative flex items-end rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] focus-within:border-[var(--color-primary)] focus-within:bg-[var(--color-surface)] focus-within:ring-[3px] focus-within:ring-[var(--color-primary)]/10 transition-all">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !isSending) {
                e.preventDefault()
                handleSend()
              }
              if (e.key === 'Escape') toggleAIPanel()
            }}
            placeholder="Ask anything..."
            aria-label="Message to AI assistant"
            rows={3}
            className="flex-1 resize-none bg-transparent text-[14px] leading-[1.6] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] px-3.5 py-3 pr-12 focus:outline-none tracking-[-0.01em]"
          />
          <div className="absolute right-2.5 bottom-2.5">
            {isSending ? (
              <button
                onClick={() => abortRef.current?.abort()}
                aria-label="Cancel request"
                className="p-2 rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                aria-label="Send message"
                className="p-2 rounded-md bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowUp size={13} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
        <p className="text-[11px] font-[var(--font-mono)] text-[var(--color-text-muted)] mt-2 text-center">Shift+Enter for new line</p>
      </div>
    </div>
  )
}

/** Coerce model-supplied block indices (number or numeric string) to a finite int. */
function asBlockIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return null
}

/** Find the document range of the top-level block with the given index. */
function topLevelBlockRange(editor: any, index: number): { from: number; to: number } | null {
  let cur = 0
  let result: { from: number; to: number } | null = null
  editor.state.doc.forEach((node: any, offset: number) => {
    if (cur === index) result = { from: offset, to: offset + node.nodeSize }
    cur++
  })
  return result
}

/**
 * Apply a batch of operations. Block-indexed operations are applied in
 * descending index order so that inserts/deletes don't shift the indices
 * of operations that haven't run yet (the model indexes the original doc).
 */
function applyOperationBatch(editor: any, ops: any[]) {
  const normalized = ops.map(op => {
    const idx = asBlockIndex(op?.paragraph_index)
    return idx === null ? op : { ...op, paragraph_index: idx }
  })
  const indexed = normalized
    .filter(op => typeof op.paragraph_index === 'number')
    .sort((a, b) => b.paragraph_index - a.paragraph_index)
  const rest = normalized.filter(op => typeof op.paragraph_index !== 'number')
  for (const op of indexed) applyOperation(editor, op)
  for (const op of rest) applyOperation(editor, op)
}

function applyOperation(editor: any, op: any) {
  switch (op.type) {
    case 'replace_content':
      editor.commands.setContent(op.content || '', { parseOptions: { preserveWhitespace: true } })
      break
    case 'insert_at_end':
      editor.commands.focus('end')
      editor.commands.insertContent(op.content)
      break
    case 'insert_at_cursor':
      editor.commands.insertContent(op.content)
      break
    case 'insert_after_paragraph': {
      const range = topLevelBlockRange(editor, op.paragraph_index ?? 0)
      const pos = range ? range.to : editor.state.doc.content.size
      editor.chain().insertContentAt(pos, op.content).run()
      break
    }
    case 'replace_paragraph': {
      const range = topLevelBlockRange(editor, op.paragraph_index ?? 0)
      if (range) {
        editor.chain().deleteRange(range).insertContentAt(range.from, op.content).run()
      } else {
        // Index out of bounds (model miscounted) — append instead of losing content
        editor.chain().insertContentAt(editor.state.doc.content.size, op.content).run()
      }
      break
    }
    case 'delete_paragraph': {
      const range = topLevelBlockRange(editor, op.paragraph_index ?? 0)
      if (range) editor.chain().deleteRange(range).run()
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
