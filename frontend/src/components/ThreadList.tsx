import { useEditorContext } from '../context/EditorContext'
import { MessageSquare, Trash2, Plus } from 'lucide-react'

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const sec = Math.round((now - then) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

interface Props {
  isOpen: boolean
  onClose: () => void
}

export function ThreadList({ isOpen, onClose }: Props) {
  const { threads, activeThreadId, switchThread, deleteThread, startNewThread } = useEditorContext()

  if (!isOpen) return null

  const handleNew = () => {
    startNewThread()
    onClose()
  }

  const handleSwitch = (id: string) => {
    switchThread(id)
    onClose()
  }

  return (
    <>
      <div className="dialog-backdrop" onClick={onClose} />
      <div className="dialog-panel w-[360px] max-w-[92vw] p-0 dialog-panel-left">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-border-light)]">
          <h3 className="dialog-title">Conversations</h3>
          <button onClick={onClose} className="dialog-close" aria-label="Close">
            <Plus size={15} className="rotate-45" />
          </button>
        </div>

        <div className="px-3 py-3 border-b border-[var(--color-border-light)]">
          <button
            onClick={handleNew}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-[var(--color-primary)] text-white text-[11px] font-mono uppercase tracking-[0.06em] font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            <Plus size={13} /> New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2" style={{ maxHeight: 'calc(100vh - 130px)' }}>
          {threads.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <MessageSquare size={20} className="text-[var(--color-text-muted)] mx-auto mb-3" />
              <p className="text-[13px] text-[var(--color-text-secondary)]">No conversations yet</p>
              <p className="text-[12px] text-[var(--color-text-tertiary)] mt-1 leading-relaxed">
                Start chatting and your history will appear here.
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5 px-2">
              {threads.map(t => {
                const active = t.id === activeThreadId
                return (
                  <li key={t.id}>
                    <div className={`group flex items-start gap-2 px-3 py-2.5 cursor-pointer transition-colors ${active ? 'bg-[var(--color-primary-subtle)] border-l-2 border-[var(--color-accent-text)]' : 'hover:bg-[var(--color-surface-tertiary)] border-l-2 border-transparent'}`}
                      onClick={() => handleSwitch(t.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-[var(--color-text-primary)] tracking-[-0.01em] truncate">
                          {t.title || 'New chat'}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 font-mono text-[10.5px] text-[var(--color-text-tertiary)] tracking-[0.04em]">
                          <span>{relativeTime(t.updatedAt)}</span>
                          <span>·</span>
                          <span className="truncate">{t.provider}{t.model ? ` · ${t.model}` : ''}</span>
                          {t.messageCount > 0 && (
                            <>
                              <span>·</span>
                              <span>{t.messageCount} msg</span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteThread(t.id) }}
                        className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] p-1 transition-all"
                        aria-label="Delete conversation"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  )
}