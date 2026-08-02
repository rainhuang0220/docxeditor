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
      className="tool-btn w-[30px] h-[30px] grid place-items-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
      title={isFocused ? 'Exit Focus Mode' : 'Focus Mode'}
    >
      {isFocused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  )
}
