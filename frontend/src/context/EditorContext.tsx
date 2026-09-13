import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Editor as TipTapEditor } from '@tiptap/react'
import {
  loadThreads, saveThreads, loadActiveThreadId, saveActiveThreadId,
  loadModelProfiles, saveModelProfiles, loadActiveModelId, saveActiveModelId,
  DEFAULT_MODEL_PROFILES,
  type ModelProfile, type StoredThread,
} from '../utils/storage'
import { showToast } from '../components/Toast'
import {
  REVIEW_BLOCK_MESSAGE,
  initialReviewState,
  persistableHtml,
  planDeleteModel,
  reduceReview,
  type ReviewEvent,
  type ReviewReduceResult,
  type SessionAction,
} from '../ai/reviewTransaction'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

interface ThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  provider: ModelProfile['provider']
  model: string
  messageCount: number
}

interface EditorContextType {
  editor: TipTapEditor | null
  setEditor: (editor: TipTapEditor | null) => void
  /** Messages of the currently-active thread. */
  messages: Message[]
  addMessage: (role: 'user' | 'assistant', content: string, streaming?: boolean) => string
  updateMessage: (id: string, content: string) => void
  finalizeMessage: (id: string, content: string) => void
  /** Clears the current thread's messages and persists an empty thread. */
  clearMessages: () => void
  isAIPanelOpen: boolean
  toggleAIPanel: () => void
  isSending: boolean
  setIsSending: (v: boolean) => void
  documentTitle: string
  setDocumentTitle: (title: string) => void
  /* Threads */
  threads: ThreadSummary[]
  activeThreadId: string | null
  /** Start a new blank thread and switch to it. Returns its id. */
  startNewThread: () => string
  switchThread: (id: string) => void
  deleteThread: (id: string) => void
  /** Persist the current message list into the active thread. Called after
   *  messages change so history survives reloads. */
  persistCurrentThread: () => void
  /* Models */
  models: ModelProfile[]
  activeModelId: string
  setActiveModelId: (id: string) => void
  upsertModel: (profile: ModelProfile) => void
  deleteModel: (id: string) => void
  /** True while an AI mutation is waiting for Accept/Reject. */
  reviewPending: boolean
  guardSession: (action: SessionAction) => boolean
  dispatchReview: (event: ReviewEvent) => ReviewReduceResult
  setReviewSnapshot: (html: string | null) => void
  getPersistableDocumentHtml: () => string
  isReviewPending: () => boolean
}

const EditorContext = createContext<EditorContextType | null>(null)

function summarizeThread(t: StoredThread): ThreadSummary {
  return {
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    provider: t.provider,
    model: t.model,
    messageCount: t.messages.length,
  }
}

function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === 'user' && m.content.trim())
  if (!firstUser) return 'New chat'
  const cleaned = firstUser.content.replace(/\s+/g, ' ').trim()
  return cleaned.length > 48 ? cleaned.slice(0, 48) + '…' : cleaned
}

export function EditorProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<TipTapEditor | null>(null)
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [documentTitle, setDocumentTitle] = useState(() => {
    return localStorage.getItem('ai-doc-ide-title') || 'Untitled Document'
  })

  /* Threads */
  const [threads, setThreads] = useState<StoredThread[]>(() => loadThreads())
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => {
    const stored = loadActiveThreadId()
    const list = loadThreads()
    if (stored && list.some(t => t.id === stored)) return stored
    return null
  })
  const messagesRef = useRef<Message[]>([])
  const [messages, setMessages] = useState<Message[]>([])

  /* Models */
  const [models, setModels] = useState<ModelProfile[]>(() => loadModelProfiles())
  const [activeModelId, setActiveModelIdState] = useState<string>(() => loadActiveModelId())

  const reviewRef = useRef(initialReviewState())
  const reviewSnapshotRef = useRef<string | null>(null)
  const [reviewPending, setReviewPending] = useState(false)

  const dispatchReview = useCallback((event: ReviewEvent): ReviewReduceResult => {
    const out = reduceReview(reviewRef.current, event)
    reviewRef.current = out.state
    setReviewPending(out.state.phase === 'pending')
    return out
  }, [])

  const guardSession = useCallback((action: SessionAction) => {
    const out = dispatchReview({ type: 'intend', action })
    if (!out.allowed) {
      showToast(REVIEW_BLOCK_MESSAGE, 'info')
    }
    return out.allowed
  }, [dispatchReview])

  const setReviewSnapshot = useCallback((html: string | null) => {
    reviewSnapshotRef.current = html
  }, [])

  const isReviewPending = useCallback(() => reviewRef.current.phase === 'pending', [])

  const getPersistableDocumentHtml = useCallback(() => {
    return persistableHtml(reviewRef.current.phase, reviewSnapshotRef.current, editor?.getHTML() ?? '')
  }, [editor])

  const handleSetTitle = useCallback((title: string) => {
    setDocumentTitle(title)
    localStorage.setItem('ai-doc-ide-title', title)
    document.title = `${title} - DocxEditor`
  }, [])

  /** Hydrate messages when the active thread changes. */
  useEffect(() => {
    if (!activeThreadId) {
      setMessages([])
      messagesRef.current = []
      return
    }
    const t = threads.find(t => t.id === activeThreadId)
    const loaded: Message[] = t ? t.messages.map(m => ({ ...m, streaming: false })) : []
    setMessages(loaded)
    messagesRef.current = loaded
  }, [activeThreadId, threads])

  /** Persist threads whenever the threads list changes. */
  useEffect(() => {
    saveThreads(threads)
  }, [threads])

  const addMessage = useCallback((role: 'user' | 'assistant', content: string, streaming?: boolean) => {
    const id = crypto.randomUUID()
    const next: Message = { id, role, content, streaming: streaming ?? false }
    setMessages(prev => {
      const updated = [...prev, next]
      messagesRef.current = updated
      return updated
    })
    return id
  }, [])

  const updateMessage = useCallback((id: string, content: string) => {
    setMessages(prev => {
      const updated = prev.map(m => m.id === id ? { ...m, content } : m)
      messagesRef.current = updated
      return updated
    })
  }, [])

  const finalizeMessage = useCallback((id: string, content: string) => {
    setMessages(prev => {
      const updated = prev.map(m => m.id === id ? { ...m, content, streaming: false } : m)
      messagesRef.current = updated
      return updated
    })
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    messagesRef.current = []
  }, [])

  const toggleAIPanel = useCallback(() => {
    if (isAIPanelOpen && !guardSession('closePanel')) return
    setIsAIPanelOpen(prev => !prev)
  }, [isAIPanelOpen, guardSession])

  const startNewThread = useCallback((initialMessages?: Message[]): string => {
    if (!guardSession('newChat')) return activeThreadId || ''
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const activeModel = models.find(m => m.id === activeModelId) || models[0]
    const msgs = initialMessages ?? messagesRef.current
    const thread: StoredThread = {
      id,
      title: deriveTitle(msgs),
      createdAt: now,
      updatedAt: now,
      provider: activeModel?.provider || 'openai',
      model: activeModel?.model || '',
      messages: msgs.map(m => ({ id: m.id, role: m.role, content: m.content })),
    }
    setThreads(prev => [thread, ...prev])
    setActiveThreadId(id)
    saveActiveThreadId(id)
    return id
  }, [models, activeModelId, guardSession, activeThreadId])

  const switchThread = useCallback((id: string) => {
    if (!guardSession('switchThread')) return
    setActiveThreadId(id)
    saveActiveThreadId(id)
  }, [guardSession])

  const deleteThread = useCallback((id: string) => {
    if (id === activeThreadId && !guardSession('deleteThread')) return
    setThreads(prev => {
      const next = prev.filter(t => t.id !== id)
      return next
    })
    setActiveThreadId(prev => {
      if (prev !== id) return prev
      const remaining = threads.filter(t => t.id !== id)
      const nextId = remaining[0]?.id ?? null
      saveActiveThreadId(nextId)
      return nextId
    })
  }, [threads, activeThreadId, guardSession])

  /** Write the current messages list back to the active thread. */
  const persistCurrentThread = useCallback(() => {
    const list = messagesRef.current
    if (list.length === 0) return
    setThreads(prev => {
      const id = activeThreadId
      if (!id) return prev
      const idx = prev.findIndex(t => t.id === id)
      if (idx < 0) return prev
      const existing = prev[idx]
      const activeModel = models.find(m => m.id === activeModelId) || models[0]
      const updated: StoredThread = {
        ...existing,
        title: deriveTitle(list),
        updatedAt: new Date().toISOString(),
        provider: activeModel?.provider || existing.provider,
        model: activeModel?.model || existing.model,
        messages: list.map(m => ({ id: m.id, role: m.role, content: m.content })),
      }
      const next = [...prev]
      next[idx] = updated
      // Newest first
      next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return next
    })
  }, [activeThreadId, activeModelId, models])

  const setActiveModelId = useCallback((id: string) => {
    if (id !== activeModelId && !guardSession('switchModel')) return
    setActiveModelIdState(id)
    saveActiveModelId(id)
  }, [activeModelId, guardSession])

  const upsertModel = useCallback((profile: ModelProfile) => {
    setModels(prev => {
      const idx = prev.findIndex(m => m.id === profile.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = profile
        return next
      }
      return [...prev, profile]
    })
  }, [])

  const deleteModel = useCallback((id: string) => {
    const plan = planDeleteModel({
      models: models.map(m => ({ id: m.id })),
      activeModelId,
      deleteId: id,
      review: { phase: reviewRef.current.phase },
    })
    if (!plan.allowed) {
      showToast(REVIEW_BLOCK_MESSAGE, 'info')
      return
    }
    setModels(prev => {
      if (prev.length <= 1) return prev
      const next = prev.filter(m => m.id !== id)
      if (activeModelId === id) {
        const fallback = next[0]?.id || DEFAULT_MODEL_PROFILES[0].id
        setActiveModelIdState(fallback)
        saveActiveModelId(fallback)
      }
      return next
    })
  }, [activeModelId, models])

  // Persist models whenever they change
  useEffect(() => {
    saveModelProfiles(models)
  }, [models])

  const threadSummaries: ThreadSummary[] = threads.map(summarizeThread)

  return (
    <EditorContext.Provider value={{
      editor, setEditor,
      messages, addMessage, updateMessage, finalizeMessage, clearMessages,
      isAIPanelOpen, toggleAIPanel,
      isSending, setIsSending,
      documentTitle, setDocumentTitle: handleSetTitle,
      threads: threadSummaries,
      activeThreadId,
      startNewThread, switchThread, deleteThread, persistCurrentThread,
      models, activeModelId, setActiveModelId, upsertModel, deleteModel,
      reviewPending, guardSession, dispatchReview, setReviewSnapshot, getPersistableDocumentHtml, isReviewPending,
    }}>
      {children}
    </EditorContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useEditorContext() {
  const ctx = useContext(EditorContext)
  if (!ctx) throw new Error('useEditorContext must be used within EditorProvider')
  return ctx
}