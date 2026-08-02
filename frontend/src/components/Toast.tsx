import { useState, useEffect, useCallback } from 'react'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'

interface ToastMessage {
  id: number
  text: string
  type: 'error' | 'success' | 'info'
}

let toastId = 0
let addToastFn: ((text: string, type: ToastMessage['type']) => void) | null = null

// eslint-disable-next-line react-refresh/only-export-components
export function showToast(text: string, type: ToastMessage['type'] = 'info') {
  addToastFn?.(text, type)
}

const TOAST_ICON = {
  success: <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />,
  error: <AlertCircle size={15} className="text-red-400 shrink-0" />,
  info: <Info size={15} className="text-[#6b9bff] shrink-0" />,
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = useCallback((text: string, type: ToastMessage['type']) => {
    const id = ++toastId
    setToasts(prev => [...prev, { id, text, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }, [])

  useEffect(() => {
    addToastFn = addToast
    return () => { addToastFn = null }
  }, [addToast])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" role="alert" aria-live="assertive">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="flex items-center gap-2.5 pl-3.5 pr-3 py-2.5 rounded-lg bg-[#1c1c1e] text-white/90 text-[13px] font-medium tracking-[-0.01em] border border-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)] animate-[slideUp_0.22s_cubic-bezier(0.16,1,0.3,1)]"
        >
          {TOAST_ICON[toast.type]}
          <span>{toast.text}</span>
          <button
            onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
            className="ml-1 p-0.5 rounded text-white/40 hover:text-white/90 hover:bg-white/10 transition-colors"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
