import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/**
 * Enhanced clipboard support for Word compatibility.
 * - Cleans up Word-specific markup when pasting from Word
 * - Handles image paste from clipboard
 */
export const ClipboardExtension = Extension.create({
  name: 'clipboardSupport',

  addProseMirrorPlugins() {
    const editor = this.editor

    return [
      new Plugin({
        key: new PluginKey('clipboardSupport'),
        props: {
          transformPastedHTML(html: string) {
            // Clean up Word-specific markup
            return html
              .replace(/<!--\[if[^]*?endif\]-->/g, '')
              .replace(/<o:p[^>]*>.*?<\/o:p>/g, '')
              .replace(/class="Mso[^"]*"/g, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/\s*mso-[^;":]+:[^;"]+;?/g, '')
              .replace(/<\/?span[^>]*>/g, '')
              .replace(/<\/?font[^>]*>/g, '')
          },
          handlePaste(_view, event) {
            const items = event.clipboardData?.items
            if (!items) return false

            for (const item of items) {
              if (item.type.startsWith('image/')) {
                event.preventDefault()
                const file = item.getAsFile()
                if (!file) return false
                const reader = new FileReader()
                reader.onload = () => {
                  const src = reader.result as string
                  editor.chain().focus().setImage({ src }).run()
                }
                reader.readAsDataURL(file)
                return true
              }
            }
            return false
          },
        },
      }),
    ]
  },
})
