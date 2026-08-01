import { useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'

export function FocusMode() {
  const [isFocused, setIsFocused] = useState(false)

  const toggle = () => {
    setIsFocused(prev => {
      const next = !prev
      document.documentElement.classList.toggle('focus-mode', next)
      return next
    })
  }

  return (
    <button
      onClick={toggle}
      className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
      title={isFocused ? 'Exit Focus Mode' : 'Focus Mode'}
    >
      {isFocused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  )
}
