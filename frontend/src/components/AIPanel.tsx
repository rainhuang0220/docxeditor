import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ArrowUp, X, Check, XCircle, Square, Sparkles, Loader2, ChevronDown, Plus, MessageSquare, FileText, Languages, Wand2, ListChecks, AlignLeft, Heading1 } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { apiUrl } from '../utils/api'
import { buildChatRequest } from '../utils/chatRequest'
import { getCredentialStatus } from '../utils/credentials'
import { initialState, reduce, type ChatEvent, type Effect, type MachineState } from '../ai/streamMachine'
import { type ReviewEffect } from '../ai/reviewTransaction'
import type { Node as PmNode } from '@tiptap/pm/model'
import { authorizeRestoreTr } from '../ai/reviewLock'
import { checkpointHistory, rejectRestoreTr, type HistoryCheckpoint } from '../ai/reviewHistory'
import { captureRequestContext, isMutatingResultStale, requireOwningThreadId, STALE_RESULT_MESSAGE, type RequestContext } from '../ai/requestContext'
import { executeAiOperations, reviewEventAfterExecute } from '../ai/applyOperations'
import { INVALID_AI_EDIT_MESSAGE, type AiOperation } from '../ai/operations'
import { tryBeginRequest, finishRequest, getInFlightRequestId, IN_FLIGHT_MESSAGE } from '../ai/requestLatch'
import { showToast } from './Toast'
import { usePersistence } from '../persistence/PersistenceContext'
import Markdown from 'react-markdown'
import { diffWords } from 'diff'
import { ThreadList } from './ThreadList'

interface Activity {
  label: string
  detail?: string
}

interface DiffStat {
  added: number
  removed: number
  detail: string[]
}

interface ReviewState {
  snapshot: string
  diff: DiffStat
}

function operationsCountOf(result: unknown): number {
  if (!result || typeof result !== 'object') return 0
  const ops = (result as { operations?: unknown }).operations
  return Array.isArray(ops) ? ops.length : 0
}

function outcomeNote(): string {
  return ' The document was not changed.'
}

interface SlashCommand {
  id: string
  name: string
  description: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  /** Pre-filled user prompt when this command is selected. */
  prompt: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'edit', name: 'Edit', description: 'Edit the selected text or rewrite a section.', icon: Wand2, prompt: 'Edit the selected text — improve clarity, tone, and flow without changing meaning.' },
  { id: 'summarize', name: 'Summarize', description: 'Produce a concise summary of the document.', icon: ListChecks, prompt: 'Summarize the document in a short bullet list of key points.' },
  { id: 'grammar', name: 'Grammar', description: 'Fix grammar and spelling across the document.', icon: AlignLeft, prompt: 'Fix grammar, spelling, and punctuation throughout the document. Preserve the original voice.' },
  { id: 'formalize', name: 'Formalize', description: 'Rewrite in a more formal, professional tone.', icon: Heading1, prompt: 'Rewrite the document in a more formal, professional tone while keeping all facts intact.' },
  { id: 'translate', name: 'Translate', description: 'Translate the document (specify a language in your message).', icon: Languages, prompt: 'Translate the document to Chinese (Simplified). Preserve headings and structure.' },
  { id: 'continue', name: 'Continue', description: 'Continue writing where the document left off.', icon: FileText, prompt: 'Continue the document from where it ends. Match the existing style and tone.' },
]

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

function opSummary(op: AiOperation): string {
  const blockNo = 'paragraph_index' in op ? ` ${op.paragraph_index + 1}` : ''
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

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || ''
}

/** Count add/remove word totals across an operation batch by diffing the
 *  pre- and post-edit document text. The batch's <ul>-style summary is
 *  too noisy for anything beyond ~5 operations; this collapses it to a
 *  single line. */
function computeDiffStat(snapshotHtml: string, liveHtml: string, ops: AiOperation[]): DiffStat {
  const before = stripHtml(snapshotHtml)
  const after = stripHtml(liveHtml)
  let added = 0
  let removed = 0
  for (const part of diffWords(before, after)) {
    const wc = part.value.trim() ? part.value.trim().split(/\s+/).length : 0
    if (part.added) added += wc
    else if (part.removed) removed += wc
  }
  // Group operations into a short human-readable detail list, not per-block.
  const counts = new Map<string, number>()
  for (const op of ops) counts.set(opSummary(op), (counts.get(opSummary(op)) ?? 0) + 1)
  const detail = [...counts.entries()].map(([label, n]) => n > 1 ? `${label} (×${n})` : label)
  return { added, removed, detail }
}

export function AIPanel() {
  const { messages, addMessage, updateMessage, finalizeMessage, isAIPanelOpen, toggleAIPanel, editor, isSending, setIsSending,
    activeThreadId, startNewThread, threads, persistCurrentThread, models, activeModelId, setActiveModelId, switchThread, credentialWarning,
    guardSession, dispatchReview, setReviewSnapshot, isReviewPending, getMessages, registerAIRequestHandlers } = useEditorContext()
  const { createVersion, persistAfterAccept, persistAfterReject } = usePersistence()
  const [input, setInput] = useState('')
  const [review, setReview] = useState<ReviewState | null>(null)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdIndex, setCmdIndex] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const snapshotRef = useRef<string | null>(null)
  const snapshotDocRef = useRef<PmNode | null>(null)
  const histCheckpointRef = useRef<HistoryCheckpoint | null>(null)
  const requestCtxRef = useRef<RequestContext | null>(null)
  const machineRef = useRef<MachineState>(initialState())
  const streamGenRef = useRef(0)
  const charsRef = useRef(0)
  const modelMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activity, review])

  /* Persist the current message list to the active thread whenever it
     changes. Skip during streaming to avoid hammering localStorage on
     every chunk. */
  useEffect(() => {
    if (!activeThreadId) return
    if (messages.some(m => m.streaming)) return
    const t = setTimeout(() => persistCurrentThread(), 250)
    return () => clearTimeout(t)
  }, [messages, activeThreadId, persistCurrentThread])

  /* Click-outside to close the model dropdown. */
  useEffect(() => {
    if (!modelMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [modelMenuOpen])

  const activeModel = useMemo(
    () => models.find(m => m.id === activeModelId) || models[0] || null,
    [models, activeModelId],
  )

  useEffect(() => {
    if (!isAIPanelOpen || !activeModel) return
    let cancelled = false
    getCredentialStatus(activeModel.id, activeModel.provider)
      .then(status => { if (!cancelled) setHasApiKey(status.has_key) })
      .catch(() => { if (!cancelled) setHasApiKey(null) })
    return () => { cancelled = true }
  }, [isAIPanelOpen, activeModel])

  const switchModel = (id: string) => {
    setActiveModelId(id)
    setModelMenuOpen(false)
  }

  const openModelManager = () => {
    setModelMenuOpen(false)
    window.dispatchEvent(new Event('open-model-manager'))
  }

  // Auto-grow textarea. The composer reserves space for the action row
  // below; we only count the typing area itself here.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'
  }, [input])

  // Open the slash command menu whenever the input starts with "/".
  // Subsequent text filters the list.
  useEffect(() => {
    if (input.startsWith('/') && !input.includes('\n')) {
      setCmdOpen(true)
    } else {
      setCmdOpen(false)
    }
    setCmdIndex(0)
  }, [input])

  // Elapsed-seconds counter for the activity indicator
  useEffect(() => {
    if (!isSending) { setElapsed(0); return }
    const t0 = Date.now()
    const iv = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => window.clearInterval(iv)
  }, [isSending])

  const endStreamingUI = useCallback(() => {
    document.body.classList.remove('ai-writing')
    if (!isReviewPending()) editor?.setEditable(true)
  }, [editor, isReviewPending])

  const presentAssistant = useCallback((result: any, streamMsgId: string | null) => {
    const ops = Array.isArray(result.operations) ? result.operations : []
    const warnings: string[] = result.warnings || []
    let displayReply = result.reply || (ops.length > 0 ? 'Done.' : 'No changes were needed.')
    if (warnings.length > 0) {
      displayReply += '\n\n' + warnings.map((w: string) => `⚠️ ${w}`).join('\n\n')
    }
    if (streamMsgId) finalizeMessage(streamMsgId, displayReply)
    else addMessage('assistant', displayReply)
  }, [addMessage, finalizeMessage])

  const applyReviewEffects = useCallback((effects: ReviewEffect[], result?: any) => {
    for (const effect of effects) {
      if (effect === 'enterPending') {
        const snapshot = snapshotRef.current
        if (snapshot === null || !editor) continue
        const ops = Array.isArray(result?.operations) ? result.operations as AiOperation[] : []
        setReview({ snapshot, diff: computeDiffStat(snapshot, editor.getHTML(), ops) })
        editor.setEditable(false)
        setReviewSnapshot(snapshot)
      } else if (effect === 'commit') {
        setReview(null)
        snapshotRef.current = null
        snapshotDocRef.current = null
        histCheckpointRef.current = null
        requestCtxRef.current = null
        setReviewSnapshot(null)
        editor?.setEditable(true)
        void persistAfterAccept()
      } else if (effect === 'restore') {
        setReview(null)
        snapshotRef.current = null
        snapshotDocRef.current = null
        histCheckpointRef.current = null
        requestCtxRef.current = null
        setReviewSnapshot(null)
        editor?.setEditable(true)
        addMessage('assistant', 'Changes rejected — the document was restored.')
        void persistAfterReject()
      } else if (effect === 'clearSnapshot') {
        setReview(null)
        snapshotRef.current = null
        snapshotDocRef.current = null
        histCheckpointRef.current = null
        requestCtxRef.current = null
        setReviewSnapshot(null)
        editor?.setEditable(true)
      }
    }
  }, [editor, addMessage, setReviewSnapshot, persistAfterAccept, persistAfterReject])

  const applyFinishedOps = useCallback((result: any): 'applied' | 'stale' | 'invalid' | 'noop' => {
    if (!editor) return 'invalid'
    const snapshot = snapshotRef.current
    if (snapshot === null) return 'noop'
    const rawOps = result?.operations
    if (!Array.isArray(rawOps) || rawOps.length === 0) return 'noop'
    const ctx = requestCtxRef.current
    if (!ctx || isMutatingResultStale({
      state: editor.state,
      ctx,
      liveRequestId: getInFlightRequestId(),
      liveThreadId: activeThreadId,
    })) {
      return 'stale'
    }
    let executed
    try {
      executed = executeAiOperations(editor, rawOps, ctx)
    } catch (err) {
      console.error('[ai-ops] unexpected apply failure', err)
      const snap = snapshotDocRef.current
      const hist = histCheckpointRef.current
      if (snap && !editor.state.doc.eq(snap)) {
        editor.view.dispatch(rejectRestoreTr(editor.state, snap, hist))
      }
      return 'invalid'
    }
    if (!executed.ok) {
      console.error('[ai-ops]', executed.reason)
      return 'invalid'
    }
    const reviewEvent = reviewEventAfterExecute(executed, result.requires_confirmation === true)
    if (!reviewEvent) return 'noop'
    const reviewOut = dispatchReview(reviewEvent)
    applyReviewEffects(reviewOut.effects, { ...result, operations: executed.operations })
    return 'applied'
  }, [editor, dispatchReview, applyReviewEffects, activeThreadId])

  const presentApplyOutcome = useCallback((
    outcome: 'applied' | 'stale' | 'invalid' | 'noop',
    result: any,
    streamMsgId: string | null,
  ) => {
    if (outcome === 'invalid') {
      if (streamMsgId) finalizeMessage(streamMsgId, INVALID_AI_EDIT_MESSAGE)
      else addMessage('assistant', INVALID_AI_EDIT_MESSAGE)
      return
    }
    if (outcome === 'stale') {
      if (streamMsgId) finalizeMessage(streamMsgId, STALE_RESULT_MESSAGE)
      else addMessage('assistant', STALE_RESULT_MESSAGE)
      return
    }
    presentAssistant(result, streamMsgId)
  }, [addMessage, finalizeMessage, presentAssistant])

  const applyStreamEffects = useCallback((effects: Effect[], result?: any): 'applied' | 'stale' | 'invalid' | 'noop' => {
    let outcome: 'applied' | 'stale' | 'invalid' | 'noop' = 'noop'
    for (const effect of effects) {
      if (effect === 'applyResult') outcome = applyFinishedOps(result)
    }
    return outcome
  }, [applyFinishedOps])

  const submitAIRequest = useCallback(async (opts: { message: string; source: 'panel' | 'selection'; anchor?: import('../ai/operationTarget').RequestAnchor }) => {
    const message = opts.message
    if (!message.trim()) return
    const requestId = tryBeginRequest()
    if (!requestId) {
      showToast(IN_FLIGHT_MESSAGE, 'info')
      return
    }
    if (!guardSession('send')) {
      finishRequest(requestId)
      return
    }
    const threadId = requireOwningThreadId(activeThreadId, () =>
      startNewThread(undefined, { ignoreInFlight: true }),
    )
    const editorState = editor?.state
    if (!threadId || !editor || !editorState) {
      finishRequest(requestId)
      return
    }
    const ctx = captureRequestContext({
      requestId,
      source: opts.source,
      state: editorState,
      html: editor.getHTML(),
      threadId,
      modelId: activeModelId,
      anchor: opts.anchor,
    })
    requestCtxRef.current = ctx
    snapshotRef.current = ctx.documentHtml
    snapshotDocRef.current = ctx.documentNode
    histCheckpointRef.current = checkpointHistory(editorState)
    setReviewSnapshot(ctx.documentHtml)
    void createVersion('Before AI edit')

    const profile = models.find(model => model.id === activeModelId) || models[0]
    if (!profile) {
      finishRequest(requestId)
      return
    }
    if (opts.source === 'panel') setInput('')
    charsRef.current = 0
    addMessage('user', message)
    setIsSending(true)
    setActivity({ label: 'Sending request' })

    const controller = new AbortController()
    abortRef.current = controller
    let streamMsgId: string | null = null
    const generation = ++streamGenRef.current
    machineRef.current = reduce(initialState(), { type: 'start' }).state

    const dispatch = (event: ChatEvent) => {
      if (streamGenRef.current !== generation) {
        return { stale: true as const, prev: machineRef.current, state: machineRef.current, effects: [] as Effect[] }
      }
      const prev = machineRef.current
      const out = reduce(prev, event)
      machineRef.current = out.state
      return { stale: false as const, prev, ...out }
    }

    try {
      const payload = JSON.stringify(buildChatRequest({
        message,
        document: ctx.documentHtml,
        selection: ctx.anchor.selectedText,
        history: getMessages().slice(-10).map(m => ({ role: m.role, content: m.content })),
        profile,
      }))

      const res = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      })

      if (res.status === 401 || res.status === 422) {
        const data = await res.json().catch(() => null)
        const text = data?.error?.message || (res.status === 401
          ? 'No API key configured. Open AI models and add a key for this profile.'
          : `AI service returned ${res.status}.`)
        const out = dispatch({ type: 'error' })
        if (!out.stale && out.prev.phase === 'streaming') {
          applyStreamEffects(out.effects)
          addMessage('assistant', text)
        }
        if (res.status === 401) setHasApiKey(false)
        return
      }

      if (!res.ok || !res.body) {
        const fallbackRes = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
        })
        if (!fallbackRes.ok) {
          const out = dispatch({ type: 'error' })
          if (!out.stale && out.prev.phase === 'streaming') {
            applyStreamEffects(out.effects)
            addMessage('assistant', `AI service returned ${fallbackRes.status}.${outcomeNote()}`)
          }
          return
        }
        const data = await fallbackRes.json()
        const out = dispatch({ type: 'fallback', operationsCount: operationsCountOf(data) })
        if (!out.stale && out.prev.phase === 'streaming') {
          presentApplyOutcome(applyStreamEffects(out.effects, data), data, null)
        }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let streamedReply = ''
      let lineBuffer = ''
      streamMsgId = addMessage('assistant', '', true)

      const handleSseLine = (line: string) => {
        if (streamGenRef.current !== generation) return
        if (!line.startsWith('data: ')) return
        let event: any
        try {
          event = JSON.parse(line.slice(6))
        } catch { return }

        switch (event.type) {
          case 'status':
            if (machineRef.current.phase !== 'streaming') break
            setActivity({
              label: event.stage === 'reading'
                ? 'Reading document'
                : event.stage === 'checking'
                  ? 'Verifying coverage'
                  : 'Thinking',
            })
            break
          case 'thinking':
            if (machineRef.current.phase !== 'streaming') break
            setActivity({ label: 'Thinking' })
            break
          case 'chunk':
            if (machineRef.current.phase !== 'streaming') break
            streamedReply += event.content
            updateMessage(streamMsgId!, streamedReply)
            setActivity(null)
            break
          case 'tool_start': {
            const out = dispatch({ type: 'tool_start', name: String(event.name || '') })
            if (out.stale || out.prev.phase !== 'streaming') break
            setActivity({ label: toolStartLabel(event.name) })
            break
          }
          case 'tool_delta': {
            const out = dispatch({ type: 'tool_delta', name: String(event.name || '') })
            if (out.stale || out.prev.phase !== 'streaming') break
            charsRef.current += String(event.content || '').length
            setActivity({ label: toolStartLabel(event.name), detail: formatChars(charsRef.current) })
            break
          }
          case 'tool_progress':
            if (machineRef.current.phase !== 'streaming') break
            if (event.chars > charsRef.current) charsRef.current = event.chars
            setActivity(prev => ({ label: prev?.label || 'Working', detail: formatChars(charsRef.current) }))
            break
          case 'done': {
            const result = event.result || {}
            const out = dispatch({ type: 'done', operationsCount: operationsCountOf(result) })
            if (out.stale || out.prev.phase !== 'streaming') break
            presentApplyOutcome(applyStreamEffects(out.effects, result), result, streamMsgId)
            break
          }
          case 'error': {
            const out = dispatch({ type: 'error' })
            if (out.stale || out.prev.phase !== 'streaming') break
            applyStreamEffects(out.effects)
            finalizeMessage(streamMsgId!, `Error: ${event.content}${outcomeNote()}`)
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
          lineBuffer = lines.pop() || ''
        } else {
          lineBuffer = ''
        }
        for (const line of lines) handleSseLine(line)
        if (done) break
      }

      const eof = dispatch({ type: 'eof' })
      if (!eof.stale && eof.prev.phase === 'streaming') {
        applyStreamEffects(eof.effects)
        const failText = `The response was interrupted before it finished.${outcomeNote()}`
        if (streamMsgId) finalizeMessage(streamMsgId, failText)
        else addMessage('assistant', failText)
      }
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === 'AbortError'
      const out = dispatch({ type: isAbort ? 'abort' : 'error' })
      if (!out.stale && out.prev.phase === 'streaming') {
        applyStreamEffects(out.effects)
        const failText = isAbort
          ? `Request cancelled.${outcomeNote()}`
          : `Failed to connect to AI service. Make sure the backend is running.${outcomeNote()}`
        if (streamMsgId) finalizeMessage(streamMsgId, failText)
        else addMessage('assistant', failText)
      }
    } finally {
      if (streamGenRef.current === generation) {
        abortRef.current = null
        setIsSending(false)
        setActivity(null)
        endStreamingUI()
        finishRequest(requestId)
      }
    }
  }, [editor, addMessage, updateMessage, finalizeMessage, setIsSending, endStreamingUI, presentApplyOutcome, applyStreamEffects, activeThreadId, startNewThread, guardSession, setReviewSnapshot, getMessages, activeModelId, models, createVersion])

  const handleSend = () => {
    if (cmdOpen) {
      // Enter on the slash menu picks the highlighted command.
      const query = input.slice(1).toLowerCase().trim()
      const matches = SLASH_COMMANDS.filter(c => c.name.toLowerCase().startsWith(query) || c.id.startsWith(query))
      const cmd = matches[cmdIndex] || matches[0]
      if (cmd) {
        void submitAIRequest({ message: cmd.prompt, source: 'panel' })
        return
      }
    }
    void submitAIRequest({ message: input.trim(), source: 'panel' })
  }

  /** Filter commands based on the query after the leading slash. */
  const filteredCommands = useMemo(() => {
    const query = input.slice(1).toLowerCase().trim()
    if (!query) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(c =>
      c.name.toLowerCase().startsWith(query) || c.id.startsWith(query) || c.description.toLowerCase().includes(query),
    )
  }, [input])

  useEffect(() => {
    registerAIRequestHandlers({
      submit: opts => { void submitAIRequest(opts) },
      abort: () => abortRef.current?.abort(),
    })
  }, [registerAIRequestHandlers, submitAIRequest])

  const acceptReview = () => {
    const out = dispatchReview({ type: 'accept' })
    applyReviewEffects(out.effects)
  }

  const rejectReview = () => {
    if (!isReviewPending()) {
      dispatchReview({ type: 'reject' })
      return
    }
    const snapshotDoc = snapshotDocRef.current
    if (editor && snapshotDoc) {
      editor.view.dispatch(authorizeRestoreTr(editor.state))
      editor.view.dispatch(rejectRestoreTr(editor.state, snapshotDoc, histCheckpointRef.current))
    }
    const out = dispatchReview({ type: 'reject' })
    applyReviewEffects(out.effects)
  }

  if (!isAIPanelOpen) return null

  return (
    <div className="ai-panel chrome-panel w-[420px] border-l border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col panel-slide">
      {/* Header */}
      <div className="flex flex-col border-b border-[var(--color-border-light)]">
        <div className="flex items-center justify-between px-4 py-2.5 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 grid place-items-center bg-[var(--color-primary)] shrink-0">
              <Sparkles size={12} className="text-white" />
            </div>
            <span className="text-[13.5px] font-semibold text-[var(--color-text-primary)] tracking-[-0.015em] shrink-0">Assistant</span>
            {/* Model selector */}
            <div ref={modelMenuRef} className="relative min-w-0">
              <button
                onClick={() => setModelMenuOpen(o => !o)}
                className="flex items-center gap-1.5 max-w-[180px] px-2 py-1 border border-[var(--color-border)] bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:border-[var(--color-border-strong)] transition-colors"
                aria-label="Switch model"
                aria-expanded={modelMenuOpen}
              >
                <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-text-secondary)] truncate">
                  {activeModel?.label || 'Model'}
                </span>
                <ChevronDown size={11} className={`text-[var(--color-text-muted)] shrink-0 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {modelMenuOpen && (
                <div className="menu-surface absolute top-full left-0 mt-1 w-[260px] z-30 anim-pop">
                  <div className="menu-list">
                    <div className="px-2 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.09em] text-[var(--color-text-muted)]">
                      Switch model
                    </div>
                    {models.map(m => {
                      const active = m.id === activeModelId
                      return (
                        <button
                          key={m.id}
                          onClick={() => switchModel(m.id)}
                          className={`menu-item ${active ? 'text-[var(--color-accent-text)]' : ''}`}
                        >
                          <span className={`w-3.5 h-3.5 grid place-items-center border ${active ? 'bg-[var(--color-primary)] border-[var(--color-primary)]' : 'border-[var(--color-border-strong)]'} shrink-0`}>
                            {active && <Check size={9} className="text-white" strokeWidth={3} />}
                          </span>
                          <span className="flex-1 truncate text-left">
                            <span className="block truncate">{m.label}</span>
                            <span className="block font-mono text-[10px] text-[var(--color-text-muted)] tracking-[0.04em] truncate">
                              {m.provider}{m.model ? ` · ${m.model}` : ''}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                    <div className="menu-separator" />
                    <button onClick={openModelManager} className="menu-item">
                      <Plus size={12} />
                      <span>Manage models…</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => startNewThread()}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
              title="New chat"
              aria-label="New chat"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => setHistoryOpen(true)}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors relative"
              title="Conversations"
              aria-label="Conversations"
            >
              <MessageSquare size={14} />
              {threads.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 grid place-items-center bg-[var(--color-primary)] text-white font-mono text-[8.5px] font-semibold leading-none">
                  {threads.length}
                </span>
              )}
            </button>
            <button
              onClick={toggleAIPanel}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
              aria-label="Close panel"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Horizontal thread tabs — newest first, scrollable. Keeps the
            most recent 5 inline so switching is one click; the full
            list lives behind the history button. */}
        <ThreadTabs
          threads={threads}
          activeThreadId={activeThreadId}
          onSwitch={switchThread}
          onNew={() => startNewThread()}
        />
      </div>

      {/* Conversation thread list drawer */}
      <ThreadList isOpen={historyOpen} onClose={() => setHistoryOpen(false)} />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4" role="log" aria-live="polite" aria-label="Chat messages">
        {credentialWarning && (
          <p className="border border-[var(--color-danger)] bg-[var(--color-surface-secondary)] px-4 py-3 text-[12.5px] text-[var(--color-danger)] leading-relaxed">
            {credentialWarning}
          </p>
        )}
        {hasApiKey === false && (
          <button
            onClick={() => window.dispatchEvent(new Event('open-model-manager'))}
            className="w-full text-left border border-[var(--color-border-strong)] bg-[var(--color-surface-secondary)] px-4 py-3 text-[13px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors cursor-pointer"
          >
            <p className="font-semibold mb-1 tracking-[-0.01em] text-[var(--color-text-primary)]">No API key configured</p>
            <p className="text-[12.5px] text-[var(--color-text-tertiary)]">Click to add a model with provider, API key, model and base URL.</p>
          </button>
        )}

        {messages.length === 0 && (
          <div className="mt-16 text-center px-4">
            <div className="w-10 h-10 grid place-items-center bg-[var(--color-surface-secondary)] border border-[var(--color-border)] mx-auto mb-5">
              <Sparkles size={16} className="text-[var(--color-accent-text)]" />
            </div>
            <p className="text-[15px] font-medium text-[var(--color-text-primary)] tracking-[-0.02em]">What can I help with?</p>
            <p className="text-[12.5px] text-[var(--color-text-tertiary)] mt-2 leading-relaxed">
              Ask me to edit, format, or rewrite<br/>any part of your document.
            </p>
          </div>
        )}

        {messages.map((msg, i) => {
          const prev = messages[i - 1]
          const isAdjacent = prev && prev.role === msg.role
          const isUser = msg.role === 'user'
          return (
            <div
              key={msg.id}
              className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-assistant'} ai-msg-item ${!isUser && isAdjacent ? 'msg-row-adjacent' : ''}`}
            >
              {!isUser && (
                <div
                  className="msg-avatar msg-avatar-assistant"
                  aria-hidden
                  title="Assistant"
                >
                  <Sparkles size={11} />
                </div>
              )}
              <div className="msg-body">
                {isUser ? (
                  <div className="flex justify-end">
                    <div className="msg-user overflow-wrap-anywhere">
                      <span className="whitespace-pre-wrap">{msg.content || '…'}</span>
                    </div>
                  </div>
                ) : (
                  (msg.content || !msg.streaming) && (
                    <div>
                      {!isAdjacent && (
                        <span className={`msg-role ${isUser ? '' : 'msg-role-accent'}`}>
                          {isUser ? 'You' : 'Assistant'}
                        </span>
                      )}
                      <div className={`msg-assistant overflow-wrap-anywhere ${msg.streaming ? 'is-streaming ai-streaming' : ''}`}>
                        <div className="ai-prose"><Markdown>{msg.content}</Markdown></div>
                      </div>
                    </div>
                  )
                )}
              </div>
              {isUser && (
                <div className="msg-avatar" aria-hidden title="You">
                  U
                </div>
              )}
            </div>
          )
        })}

        {/* Live activity indicator */}
        {isSending && (
          <div className="ai-activity ai-msg-item" aria-live="polite">
            <Loader2 size={12} className="animate-spin text-[var(--color-accent-text)] shrink-0" />
            <span className="ai-activity-label">{activity?.label ?? 'Waiting for model'}…</span>
            {activity?.detail && (
              <span className="font-mono text-[11.5px] text-[var(--color-text-muted)] tabular-nums">{activity.detail}</span>
            )}
            {elapsed > 0 && (
              <span className="font-mono text-[11.5px] text-[var(--color-text-muted)] tabular-nums">· {elapsed}s</span>
            )}
          </div>
        )}

        {review && !isSending && <ReviewBar review={review} onAccept={acceptReview} onReject={rejectReview} />}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-4 pb-3 pt-3 border-t border-[var(--color-border-light)]">
        {messages.length === 0 && !isSending && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {['Summarize', 'Fix grammar', 'Format headings', 'Make formal'].map(suggestion => (
              <button
                key={suggestion}
                onClick={() => void submitAIRequest({ message: suggestion, source: 'panel' })}
                className="px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.06em] font-medium text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:border-[var(--color-accent-text)] hover:text-[var(--color-accent-text)] transition-colors"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <div className="relative">
          <div className="ai-composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (cmdOpen) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setCmdIndex(i => Math.min(i + 1, filteredCommands.length - 1))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setCmdIndex(i => Math.max(i - 1, 0))
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setInput('')
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !isSending) {
                  e.preventDefault()
                  handleSend()
                }
                if (e.key === 'Escape' && !cmdOpen) toggleAIPanel()
              }}
              placeholder="Ask anything — or type / for commands"
              aria-label="Message to AI assistant"
              rows={1}
              className="ai-composer-textarea"
            />
            <div className="ai-composer-actions">
              <span className="ai-composer-hint">
                <kbd className="ai-composer-kbd">⏎</kbd> send · <kbd className="ai-composer-kbd">⇧⏎</kbd> newline
              </span>
              {isSending ? (
                <button
                  onClick={() => abortRef.current?.abort()}
                  aria-label="Cancel request"
                  className="ai-composer-cancel"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  aria-label="Send message"
                  className="ai-composer-send"
                >
                  <ArrowUp size={13} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>

          {/* Slash command menu — appears above the composer when the
              input starts with "/" and stays anchored to the field. */}
          {cmdOpen && filteredCommands.length > 0 && (
            <div className="cmd-menu absolute bottom-full left-0 right-0 mb-1.5 z-30 anim-pop max-h-[280px] overflow-y-auto">
              {filteredCommands.map((cmd, i) => {
                const Icon = cmd.icon
                const active = i === cmdIndex
                return (
                  <button
                    key={cmd.id}
                    onClick={() => void submitAIRequest({ message: cmd.prompt, source: 'panel' })}
                    onMouseEnter={() => setCmdIndex(i)}
                    className={`cmd-item ${active ? 'is-active' : ''}`}
                  >
                    <span className="cmd-item-glyph"><Icon size={12} /></span>
                    <span className="flex-1 min-w-0">
                      <span className="cmd-item-name">/{cmd.name}</span>
                      <span className="cmd-item-desc">{cmd.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Inline horizontal tabs for the most-recent threads. Click switches,
 *  the trailing "+" starts a fresh thread. */
function ThreadTabs({ threads, activeThreadId, onSwitch, onNew }: {
  threads: { id: string; title: string }[]
  activeThreadId: string | null
  onSwitch: (id: string) => void
  onNew: () => void
}) {
  // Show at most 4 inline; the history drawer has the full list.
  const visible = threads.slice(0, 4)
  if (visible.length === 0 && !activeThreadId) {
    return null
  }
  return (
    <div className="flex items-center gap-0 px-3 pb-0 pt-0 border-t border-[var(--color-border-light)]">
      <div className="thread-tabs">
        {visible.map(t => {
          const active = t.id === activeThreadId
          return (
            <button
              key={t.id}
              onClick={() => onSwitch(t.id)}
              className={`thread-tab ${active ? 'is-active' : ''}`}
              title={t.title}
            >
              <span className="truncate">{t.title || 'New chat'}</span>
            </button>
          )
        })}
      </div>
      <button
        onClick={onNew}
        className="shrink-0 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        title="New chat"
        aria-label="New chat"
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

/** Diff-stat + accept/reject bar. */
function ReviewBar({ review, onAccept, onReject }: {
  review: ReviewState
  onAccept: () => void
  onReject: () => void
}) {
  const [open, setOpen] = useState(false)
  const { added, removed, detail } = review.diff
  const total = added + removed
  const addPct = total > 0 ? (added / total) * 100 : 0

  return (
    <div className="diff-stat ai-msg-item">
      <div className="diff-stat-head">
        <span className="diff-add">+{added}</span>
        <span className="diff-del">−{removed}</span>
        <span className="text-[var(--color-text-muted)]">·</span>
        <span className="text-[var(--color-text-secondary)]">{detail.length} change{detail.length === 1 ? '' : 's'}</span>
        <div className="diff-bar" aria-hidden>
          {added > 0 && <div className="diff-bar-add" style={{ width: `${addPct}%` }} />}
          {removed > 0 && <div className="diff-bar-del" style={{ width: `${100 - addPct}%` }} />}
        </div>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          aria-label={open ? 'Hide detail' : 'Show detail'}
        >
          <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && detail.length > 0 && (
        <ul className="diff-stat-detail space-y-1">
          {detail.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}
      <div className="flex gap-1.5 px-3 pb-3">
        <button onClick={onAccept} className="btn btn-primary flex-1">
          <Check size={12} /> Accept
        </button>
        <button onClick={onReject} className="btn btn-secondary">
          <XCircle size={12} /> Reject
        </button>
      </div>
    </div>
  )
}

