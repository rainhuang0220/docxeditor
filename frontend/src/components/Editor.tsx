import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import ImageResize from 'tiptap-extension-resize-image'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import FontFamily from '@tiptap/extension-font-family'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import Highlight from '@tiptap/extension-highlight'
import Superscript from '@tiptap/extension-superscript'
import Subscript from '@tiptap/extension-subscript'
import { FontSize } from '../extensions/FontSize'
import { KeyboardShortcuts } from '../extensions/KeyboardShortcuts'
import { ClipboardExtension } from '../extensions/ClipboardSupport'
import { PageBreak } from '../extensions/PageBreak'
import { useEffect, useState, useCallback } from 'react'
import { useEditorContext } from '../context/EditorContext'
import { loadDocument, setupAutoSave } from '../utils/storage'
import { apiUrl } from '../utils/api'
import { showToast } from './Toast'

interface PageStyle {
  width: string
  minHeight: string
  paddingTop: string
  paddingBottom: string
  paddingLeft: string
  paddingRight: string
}

export function Editor() {
  const { setEditor, setDocumentTitle } = useEditorContext()
  const [pageStyle, setPageStyle] = useState<PageStyle>({
    width: '210mm',
    minHeight: '297mm',
    paddingTop: '25.4mm',
    paddingBottom: '25.4mm',
    paddingLeft: '25.4mm',
    paddingRight: '25.4mm',
  })

  const defaultContent = `
      <h1 style="text-align: center">Untitled Document</h1>
      <p style="text-align: center"><em>Created with AI Document IDE</em></p>
      <p></p>
      <h2>Introduction</h2>
      <p>Start writing here, or ask the AI assistant to help you create content.</p>
      <p></p>
    `

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Underline,
      TextStyle,
      Color,
      ImageResize.configure({ inline: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      FontFamily,
      FontSize,
      KeyboardShortcuts,
      ClipboardExtension,
      Link.configure({ openOnClick: false }),
      Highlight.configure({ multicolor: true }),
      Superscript,
      Subscript,
      Placeholder.configure({ placeholder: 'Start typing your document...' }),
      PageBreak,
    ],
    content: loadDocument() || defaultContent,
    editorProps: {
      attributes: {
        spellcheck: 'true',
      },
    },
  })

  // Auto-save
  useEffect(() => {
    if (!editor) return
    const cleanup = setupAutoSave(() => editor.getHTML())
    return cleanup
  }, [editor])

  // Listen for page style changes
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setPageStyle(detail)
    }
    window.addEventListener('editor:set-page-style', handler)
    return () => window.removeEventListener('editor:set-page-style', handler)
  }, [])

  useEffect(() => {
    setEditor(editor)
    return () => setEditor(null)
  }, [editor, setEditor])

  // Drag-and-drop DOCX import
  const [isDragging, setIsDragging] = useState(false)

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file || !file.name.endsWith('.docx')) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch(apiUrl('/api/import'), { method: 'POST', body: formData })
      const data = await res.json()
      if (data.html && editor) {
        editor.commands.setContent(data.html)
        setDocumentTitle(file.name.replace(/\.docx$/i, ''))
      }
    } catch {
      showToast('Import failed. Is the backend running?', 'error')
    }
  }, [editor, setDocumentTitle])

  return (
    <div
      className="py-6 relative"
      onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-20 bg-blue-50/80 border-2 border-dashed border-blue-400 rounded-lg flex items-center justify-center">
          <p className="text-blue-600 font-medium text-sm">Drop .docx file to import</p>
        </div>
      )}
      {/* Header */}
      <div
        className="mx-auto mb-0 border-b border-gray-200 dark:border-gray-700 px-6 py-2 text-center text-xs text-gray-400"
        style={{ width: pageStyle.width }}
        contentEditable
        suppressContentEditableWarning
      >
        Document Header
      </div>

      {/* Main page */}
      <div
        className="document-page"
        style={{
          width: pageStyle.width,
          minHeight: pageStyle.minHeight,
          paddingTop: pageStyle.paddingTop,
          paddingBottom: pageStyle.paddingBottom,
          paddingLeft: pageStyle.paddingLeft,
          paddingRight: pageStyle.paddingRight,
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {/* Footer */}
      <div
        className="mx-auto mt-0 border-t border-gray-200 dark:border-gray-700 px-6 py-2 flex justify-between text-xs text-gray-400"
        style={{ width: pageStyle.width }}
      >
        <span contentEditable suppressContentEditableWarning>Footer text</span>
        <span>Page 1</span>
      </div>
    </div>
  )
}
