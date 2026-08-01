import { createContext, useContext, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { Editor as TipTapEditor } from '@tiptap/react'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

interface EditorContextType {
  editor: TipTapEditor | null
  setEditor: (editor: TipTapEditor | null) => void
  messages: Message[]
  addMessage: (role: 'user' | 'assistant', content: string, streaming?: boolean) => string
  updateMessage: (id: string, content: string) => void
  finalizeMessage: (id: string, content: string) => void
  clearMessages: () => void
  isAIPanelOpen: boolean
  toggleAIPanel: () => void
  isSending: boolean
  setIsSending: (v: boolean) => void
  documentTitle: string
  setDocumentTitle: (title: string) => void
}

const EditorContext = createContext<EditorContextType | null>(null)

export function EditorProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<TipTapEditor | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [documentTitle, setDocumentTitle] = useState(() => {
    return localStorage.getItem('ai-doc-ide-title') || 'Untitled Document'
  })

  const handleSetTitle = useCallback((title: string) => {
    setDocumentTitle(title)
    localStorage.setItem('ai-doc-ide-title', title)
  }, [])

  const addMessage = useCallback((role: 'user' | 'assistant', content: string, streaming?: boolean) => {
    const id = crypto.randomUUID()
    setMessages(prev => [...prev, { id, role, content, streaming: streaming ?? false }])
    return id
  }, [])

  const updateMessage = useCallback((id: string, content: string) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, content } : m))
  }, [])

  const finalizeMessage = useCallback((id: string, content: string) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, content, streaming: false } : m))
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  const toggleAIPanel = useCallback(() => {
    setIsAIPanelOpen(prev => !prev)
  }, [])

  return (
    <EditorContext.Provider value={{
      editor, setEditor,
      messages, addMessage, updateMessage, finalizeMessage, clearMessages,
      isAIPanelOpen, toggleAIPanel,
      isSending, setIsSending,
      documentTitle, setDocumentTitle: handleSetTitle,
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
