import { useState, useEffect } from 'react'
import { X } from 'lucide-react'

const shortcuts = [
  { category: 'General', items: [
    { keys: 'Ctrl+S', desc: 'Save version' },
    { keys: 'Ctrl+F', desc: 'Find & Replace' },
    { keys: 'Ctrl+H', desc: 'Find & Replace' },
    { keys: 'Ctrl+P', desc: 'Print' },
    { keys: 'Ctrl+Z', desc: 'Undo' },
    { keys: 'Ctrl+Shift+Z', desc: 'Redo' },
    { keys: 'Ctrl+/', desc: 'Toggle AI panel' },
    { keys: 'Ctrl+Shift+S', desc: 'Export as DOCX' },
    { keys: 'Ctrl+Shift+/', desc: 'Keyboard shortcuts' },
  ]},
  { category: 'Formatting', items: [
    { keys: 'Ctrl+B', desc: 'Bold' },
    { keys: 'Ctrl+I', desc: 'Italic' },
    { keys: 'Ctrl+U', desc: 'Underline' },
    { keys: 'Ctrl+K', desc: 'Insert link' },
    { keys: 'Ctrl+Shift+X', desc: 'Strikethrough' },
    { keys: 'Ctrl+.', desc: 'Superscript' },
    { keys: 'Ctrl+,', desc: 'Subscript' },
    { keys: 'Ctrl+\\', desc: 'Clear formatting' },
  ]},
  { category: 'Alignment', items: [
    { keys: 'Ctrl+Shift+L', desc: 'Align left' },
    { keys: 'Ctrl+Shift+E', desc: 'Align center' },
    { keys: 'Ctrl+Shift+R', desc: 'Align right' },
    { keys: 'Ctrl+Shift+J', desc: 'Justify' },
  ]},
  { category: 'Headings & Blocks', items: [
    { keys: 'Ctrl+Shift+1', desc: 'Heading 1' },
    { keys: 'Ctrl+Shift+2', desc: 'Heading 2' },
    { keys: 'Ctrl+Shift+3', desc: 'Heading 3' },
    { keys: 'Ctrl+Shift+Q', desc: 'Blockquote' },
    { keys: 'Ctrl+Enter', desc: 'Page break' },
  ]},
  { category: 'Tables & Lists', items: [
    { keys: 'Tab', desc: 'Next cell / Indent list' },
    { keys: 'Shift+Tab', desc: 'Previous cell / Outdent list' },
  ]},
]

export function KeyboardShortcutsDialog() {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '/') {
        e.preventDefault()
        setIsOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!isOpen) return null

  return (
    <>
      <div className="dialog-backdrop" onClick={() => setIsOpen(false)} />
      <div className="dialog-panel w-[520px] max-w-[90vw] max-h-[80vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="dialog-title">Keyboard Shortcuts</h3>
          <button onClick={() => setIsOpen(false)} className="dialog-close">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-5">
          {shortcuts.map(section => (
            <div key={section.category}>
              <h4 className="eyebrow mb-2">{section.category}</h4>
              <div className="space-y-0.5">
                {section.items.map(item => (
                  <div key={item.keys} className="flex items-center justify-between py-1.5">
                    <span className="text-[13px] text-[var(--color-text-secondary)]">{item.desc}</span>
                    <kbd className="kbd">
                      {item.keys.replace(/Ctrl/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-6 text-[11px] text-[var(--color-text-muted)] text-center font-mono uppercase tracking-[0.06em]">⌘ + Shift + / to toggle</p>
      </div>
    </>
  )
}
