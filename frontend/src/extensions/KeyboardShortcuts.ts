import { Extension } from '@tiptap/core'

/**
 * Custom keyboard shortcuts for the document editor.
 * Mirrors standard Word/Docs shortcuts.
 */
export const KeyboardShortcuts = Extension.create({
  name: 'customKeyboardShortcuts',

  addKeyboardShortcuts() {
    return {
      // Ctrl+Shift+L — align left
      'Mod-Shift-l': ({ editor }) => {
        editor.chain().focus().setTextAlign('left').run()
        return true
      },
      // Ctrl+Shift+E — align center
      'Mod-Shift-e': ({ editor }) => {
        editor.chain().focus().setTextAlign('center').run()
        return true
      },
      // Ctrl+Shift+R — align right
      'Mod-Shift-r': ({ editor }) => {
        editor.chain().focus().setTextAlign('right').run()
        return true
      },
      // Ctrl+Shift+J — justify
      'Mod-Shift-j': ({ editor }) => {
        editor.chain().focus().setTextAlign('justify').run()
        return true
      },
      // Ctrl+Shift+1 — Heading 1
      'Mod-Shift-1': ({ editor }) => {
        editor.chain().focus().toggleHeading({ level: 1 }).run()
        return true
      },
      // Ctrl+Shift+2 — Heading 2
      'Mod-Shift-2': ({ editor }) => {
        editor.chain().focus().toggleHeading({ level: 2 }).run()
        return true
      },
      // Ctrl+Shift+3 — Heading 3
      'Mod-Shift-3': ({ editor }) => {
        editor.chain().focus().toggleHeading({ level: 3 }).run()
        return true
      },
      // Ctrl+K — insert/edit link (dispatches event to toolbar)
      'Mod-k': () => {
        window.dispatchEvent(new CustomEvent('editor:open-link-input'))
        return true
      },
      // Ctrl+Shift+Q — blockquote
      'Mod-Shift-q': ({ editor }) => {
        editor.chain().focus().toggleBlockquote().run()
        return true
      },
      // Ctrl+Shift+X — strikethrough
      'Mod-Shift-x': ({ editor }) => {
        editor.chain().focus().toggleStrike().run()
        return true
      },
      // Ctrl+. — superscript
      'Mod-.': ({ editor }) => {
        editor.chain().focus().toggleSuperscript().run()
        return true
      },
      // Ctrl+, — subscript
      'Mod-,': ({ editor }) => {
        editor.chain().focus().toggleSubscript().run()
        return true
      },
      // Ctrl+Shift+S — export as DOCX
      'Mod-Shift-s': () => {
        window.dispatchEvent(new CustomEvent('editor:trigger-export'))
        return true
      },
      // Ctrl+/ — toggle AI panel
      'Mod-/': () => {
        window.dispatchEvent(new CustomEvent('editor:toggle-ai-panel'))
        return true
      },
      // Ctrl+\ — clear formatting
      'Mod-\\': ({ editor }) => {
        editor.chain().focus().unsetAllMarks().clearNodes().run()
        return true
      },
      // Tab — move to next cell in table (or indent list)
      'Tab': ({ editor }) => {
        if (editor.isActive('table')) {
          return editor.chain().focus().goToNextCell().run()
        }
        if (editor.isActive('listItem')) {
          return editor.chain().focus().sinkListItem('listItem').run()
        }
        return false
      },
      // Shift+Tab — move to previous cell in table (or outdent list)
      'Shift-Tab': ({ editor }) => {
        if (editor.isActive('table')) {
          return editor.chain().focus().goToPreviousCell().run()
        }
        if (editor.isActive('listItem')) {
          return editor.chain().focus().liftListItem('listItem').run()
        }
        return false
      },
    }
  },
})
