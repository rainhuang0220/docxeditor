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

const CustomTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: element => element.getAttribute('data-background-color') || element.style.backgroundColor || null,
        renderHTML: attributes => {
          if (!attributes.backgroundColor) return {}
          return { style: `background-color: ${attributes.backgroundColor}`, 'data-background-color': attributes.backgroundColor }
        },
      },
    }
  },
})
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
import { ReviewLock } from '../extensions/ReviewLock'
import { DocumentRevision } from '../extensions/DocumentRevision'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useEditorContext } from '../context/EditorContext'
import { loadDocument, setupAutoSave, saveHeaderFooter, loadHeaderFooter } from '../utils/storage'
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
  const { setEditor, setDocumentTitle, getPersistableDocumentHtml, guardSession, isReviewPending, reviewPending } = useEditorContext()
  const isReviewPendingRef = useRef(isReviewPending)
  isReviewPendingRef.current = isReviewPending
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
      CustomTableCell,
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
      ReviewLock.configure({
        isLocked: () => isReviewPendingRef.current(),
      }),
      DocumentRevision,
    ],
    content: loadDocument() || defaultContent,
    // Preserve whitespace runs (e.g. Chinese first-line indents typed as
    // spaces) instead of collapsing them when content is parsed.
    parseOptions: { preserveWhitespace: true },
    editorProps: {
      attributes: {
        spellcheck: 'true',
      },
    },
  })

  // Auto-save
  useEffect(() => {
    if (!editor) return
    const cleanup = setupAutoSave(() => getPersistableDocumentHtml())
    return cleanup
  }, [editor, getPersistableDocumentHtml])

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
    if (!guardSession('mutateDocument')) return
    // Auto-save current state before replacing
    window.dispatchEvent(new CustomEvent('editor:save-version', { detail: { description: 'Before import' } }))
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch(apiUrl('/api/import'), { method: 'POST', body: formData })
      const data = await res.json()
      if (data.html && editor) {
        editor.commands.setContent(data.html)
        setDocumentTitle(file.name.replace(/\.docx$/i, ''))
        showToast(`Opened "${file.name}"`, 'success')
      }
    } catch {
      showToast('Import failed. Is the backend running?', 'error')
    }
  }, [editor, setDocumentTitle, guardSession])

  // Header/footer persistence
  const headerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLSpanElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const [headerFooter] = useState(() => loadHeaderFooter())
  const [pageCount, setPageCount] = useState(1)

  const saveHF = useCallback(() => {
    const h = headerRef.current?.textContent || ''
    const f = footerRef.current?.textContent || ''
    saveHeaderFooter(h, f)
  }, [])

  // Estimate page count from content height
  useEffect(() => {
    if (!editor || !pageRef.current) return
    const observer = new ResizeObserver(() => {
      const el = pageRef.current
      if (!el) return
      // A4 page content height: 297mm - top/bottom padding
      const pageHeightPx = el.clientHeight
      const minHeightPx = parseFloat(getComputedStyle(el).minHeight) || pageHeightPx
      const pages = Math.max(1, Math.ceil(pageHeightPx / minHeightPx))
      setPageCount(pages)
    })
    const el = pageRef.current.querySelector('.ProseMirror')
    if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [editor])

  return (
    <div
      className="py-6 relative"
      onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-20 bg-[var(--color-primary-light)]/80 backdrop-blur-[2px] border-2 border-dashed border-[var(--color-primary)] rounded-lg flex items-center justify-center">
          <p className="text-[var(--color-primary)] font-medium text-sm">Drop .docx file to import</p>
        </div>
      )}
      {/* Header */}
      <div
        ref={headerRef}
        className="mx-auto mb-0 border-b border-[var(--color-page-rule)] px-6 py-2 text-center text-[11px] text-[#949494]"
        style={{ width: pageStyle.width }}
        contentEditable={!reviewPending}
        suppressContentEditableWarning
        onBlur={saveHF}
      >
        {headerFooter.header || 'Document Header'}
      </div>

      {/* Main page */}
      <div
        ref={pageRef}
        className="document-page"
        style={{
          width: pageStyle.width,
          minHeight: pageStyle.minHeight,
          paddingTop: pageStyle.paddingTop,
          paddingBottom: pageStyle.paddingBottom,
          paddingLeft: pageStyle.paddingLeft,
          paddingRight: pageStyle.paddingRight,
        }}
        onMouseDown={e => {
          // Clicking the blank page area (below the last paragraph) should
          // place the caret at the end of the document, like Word does.
          if (e.target === pageRef.current && editor && editor.isEditable) {
            e.preventDefault()
            editor.chain().focus('end').run()
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {/* Footer */}
      <div
        className="mx-auto mt-0 border-t border-[var(--color-page-rule)] px-6 py-2 flex justify-between text-[11px] text-[#949494]"
        style={{ width: pageStyle.width }}
      >
        <span
          ref={footerRef}
          contentEditable={!reviewPending}
          suppressContentEditableWarning
          onBlur={saveHF}
        >
          {headerFooter.footer || 'Footer text'}
        </span>
        <span>Page 1 of {pageCount}</span>
      </div>
    </div>
  )
}
