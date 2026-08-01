import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'

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
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-sm animate-[slideIn_0.2s_ease-out] ${
            toast.type === 'error' ? 'bg-red-600 text-white' :
            toast.type === 'success' ? 'bg-green-600 text-white' :
            'bg-gray-800 text-white'
          }`}
        >
          <span>{toast.text}</span>
          <button
            onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
            className="ml-1 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
