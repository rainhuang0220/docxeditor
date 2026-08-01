import { useState, useEffect } from 'react'
import { X } from 'lucide-react'

const shortcuts = [
  { category: 'General', items: [
    { keys: 'Ctrl+S', desc: 'Save version' },
    { keys: 'Ctrl+F', desc: 'Find & Replace' },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-[480px] max-h-[80vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-100">Keyboard Shortcuts</h3>
          <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {shortcuts.map(section => (
            <div key={section.category}>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">{section.category}</h4>
              <div className="space-y-1">
                {section.items.map(item => (
                  <div key={item.keys} className="flex items-center justify-between py-1">
                    <span className="text-sm text-gray-700 dark:text-gray-300">{item.desc}</span>
                    <kbd className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded font-mono text-gray-600 dark:text-gray-300">
                      {item.keys.replace(/Ctrl/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-gray-400 text-center">Press Ctrl+Shift+/ to toggle this dialog</p>
      </div>
    </div>
  )
}
