import { useEditor, EditorContent } from '@tiptap/react'
import { createDocxEditorExtensions } from '../extensions/createDocxEditorExtensions'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useEditorContext } from '../context/EditorContext'
import { saveHeaderFooter, loadHeaderFooter } from '../utils/storage'
import { apiUrl } from '../utils/api'
import { showToast } from './Toast'
import { usePersistence } from '../persistence/PersistenceContext'
import { DEFAULT_DOCUMENT_HTML, resolveInitialHtml } from '../persistence/hydrate'

interface PageStyle {
  width: string
  minHeight: string
  paddingTop: string
  paddingBottom: string
  paddingLeft: string
  paddingRight: string
}

export function Editor() {
  const { hydration, startNewDocumentFromBlocked } = usePersistence()

  if (hydration.phase === 'blocked') {
    return (
      <div className="py-6">
        <div className="mx-auto document-page" style={{ width: '210mm', minHeight: '40vh' }}>
          <p className="text-sm text-[var(--color-danger)] mb-3">{hydration.message}</p>
          <p className="text-sm text-[var(--color-text-tertiary)] mb-4">
            The saved document was not loaded, so it will not be overwritten.
          </p>
          <button type="button" className="btn btn-primary" onClick={startNewDocumentFromBlocked}>
            Start new document
          </button>
        </div>
      </div>
    )
  }

  const initialHtml = resolveInitialHtml(hydration, DEFAULT_DOCUMENT_HTML)
  if (initialHtml === null) return null
  return <EditorInner initialHtml={initialHtml} />
}

function EditorInner({ initialHtml }: { initialHtml: string }) {
  const { setEditor, setDocumentTitle, guardSession, isReviewPending, reviewPending } = useEditorContext()
  const { createVersion, beginDestructiveTransition, flushNow } = usePersistence()
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

  const editor = useEditor({
    extensions: createDocxEditorExtensions({
      environment: 'interactive',
      isLocked: () => isReviewPendingRef.current(),
    }),
    content: initialHtml,
    parseOptions: { preserveWhitespace: true },
    editorProps: {
      attributes: {
        spellcheck: 'true',
      },
    },
  })

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

  const [isDragging, setIsDragging] = useState(false)

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file || !file.name.endsWith('.docx')) return
    if (!guardSession('mutateDocument')) return
    try {
      await createVersion('Before import')
    } catch {
      /* version failure already surfaced */
    }
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch(apiUrl('/api/import'), { method: 'POST', body: formData })
      const data = await res.json()
      if (data.html && editor) {
        await beginDestructiveTransition()
        editor.commands.setContent(data.html)
        setDocumentTitle(file.name.replace(/\.docx$/i, ''))
        await flushNow()
        showToast(`Opened "${file.name}"`, 'success')
      }
    } catch {
      showToast('Import failed. Is the backend running?', 'error')
    }
  }, [editor, setDocumentTitle, guardSession, createVersion, beginDestructiveTransition, flushNow])

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

  useEffect(() => {
    if (!editor || !pageRef.current) return
    const observer = new ResizeObserver(() => {
      const el = pageRef.current
      if (!el) return
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
          if (e.target === pageRef.current && editor && editor.isEditable) {
            e.preventDefault()
            editor.chain().focus('end').run()
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>

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
