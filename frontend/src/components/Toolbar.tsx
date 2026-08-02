import {
  Bold, Italic, Underline as UnderlineIcon, AlignLeft, AlignCenter,
  AlignRight, AlignJustify, List, ListOrdered, Undo2, Redo2,
  Image as ImageIcon, MessageSquare, Download,
  Heading1, Heading2, Heading3, Upload, Palette,
  Strikethrough, Highlighter, Link, Printer, Indent, Outdent, Code,
  Superscript, Subscript, SeparatorHorizontal, Quote, RemoveFormatting,
} from 'lucide-react'
import { useRef, useEffect, useState } from 'react'
import { useEditorContext } from '../context/EditorContext'
import { NewDocumentDialog } from './NewDocumentDialog'
import { ThemeToggle } from './ThemeToggle'
import { ApiKeyDialog } from './ApiKeyDialog'
import { ModelManager } from './ModelManager'
import { FocusMode } from './FocusMode'
import { TableOfContents } from './TableOfContents'
import { PageSettingsDialog } from './PageSettingsDialog'
import { InsertTableDialog } from './InsertTableDialog'
import { apiUrl } from '../utils/api'
import { showToast } from './Toast'

function ToolButton({ onClick, active, children, title }: {
  onClick: () => void
  active?: boolean
  children: React.ReactNode
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`tool-btn w-[30px] h-[30px] grid place-items-center ${active ? 'bg-[var(--color-primary-light)] text-[var(--color-accent-text)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}`}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-[18px] bg-[var(--color-border)] mx-1.5 shrink-0" />
}

export function Toolbar() {
  const { editor, toggleAIPanel, documentTitle, setDocumentTitle } = useEditorContext()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const colorInputRef = useRef<HTMLInputElement>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [showLinkInput, setShowLinkInput] = useState(false)
  const linkInputRef = useRef<HTMLInputElement>(null)

  const getPageSettings = () => {
    const page = document.querySelector('.document-page') as HTMLElement
    if (!page) return undefined
    return {
      width: page.style.width || '210mm',
      minHeight: page.style.minHeight || '297mm',
      paddingTop: page.style.paddingTop || '25.4mm',
      paddingBottom: page.style.paddingBottom || '25.4mm',
      paddingLeft: page.style.paddingLeft || '25.4mm',
      paddingRight: page.style.paddingRight || '25.4mm',
    }
  }

  // Listen for toggle-ai-panel and trigger-export events from keyboard shortcuts
  useEffect(() => {
    const handleToggleAI = () => toggleAIPanel()
    const handleExport = () => {
      if (!editor) return
      const html = editor.getHTML()
      const filename = `${documentTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}.docx`
      const pageSettings = getPageSettings()
      fetch(apiUrl('/api/export/download'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html_content: html, filename, page_settings: pageSettings }),
      })
        .then(res => { if (!res.ok) throw new Error(); return res.blob() })
        .then(blob => {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = filename
          a.click()
          URL.revokeObjectURL(url)
          showToast(`Exported "${filename}"`, 'success')
        })
        .catch(() => showToast('Export failed. Is the backend running?', 'error'))
    }
    const handleOpenLink = () => {
      setShowLinkInput(true)
      setTimeout(() => linkInputRef.current?.focus(), 50)
    }
    window.addEventListener('editor:toggle-ai-panel', handleToggleAI)
    window.addEventListener('editor:trigger-export', handleExport)
    window.addEventListener('editor:open-link-input', handleOpenLink)
    return () => {
      window.removeEventListener('editor:toggle-ai-panel', handleToggleAI)
      window.removeEventListener('editor:trigger-export', handleExport)
      window.removeEventListener('editor:open-link-input', handleOpenLink)
    }
  }, [editor, toggleAIPanel, documentTitle])

  if (!editor) return null

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch(apiUrl('/api/import'), { method: 'POST', body: formData })
      const data = await res.json()
      if (data.html) {
        editor.commands.setContent(data.html)
        const name = file.name.replace(/\.docx$/i, '')
        setDocumentTitle(name)
        showToast(`Opened "${file.name}"`, 'success')
      }
    } catch {
      showToast('Import failed. Is the backend running?', 'error')
    }
    e.target.value = ''
  }

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex-wrap" role="toolbar" aria-label="Document formatting">
      <NewDocumentDialog />

      {/* Editable document title */}
      <input
        type="text"
        value={documentTitle}
        onChange={e => setDocumentTitle(e.target.value)}
        className="h-[30px] text-[13px] border border-transparent bg-transparent px-2.5 font-medium tracking-[-0.01em] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-border-strong)] focus:bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-secondary)] min-w-[120px] max-w-[220px] transition-colors"
        title="Document title"
      />

      <Divider />

      {/* Font family */}
      <select
        value={editor.getAttributes('textStyle').fontFamily || 'Times New Roman'}
        onChange={e => editor.chain().focus().setFontFamily(e.target.value).run()}
        className="toolbar-select"
      >
        <option value="Times New Roman">Times New Roman</option>
        <option value="Arial">Arial</option>
        <option value="Georgia">Georgia</option>
        <option value="Courier New">Courier New</option>
        <option value="Verdana">Verdana</option>
      </select>

      {/* Font size */}
      <select
        className="toolbar-select w-[62px]"
        defaultValue="12"
        onChange={e => editor.chain().focus().setFontSize(`${e.target.value}pt`).run()}
      >
        {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map(s => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <Divider />

      <ToolButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold">
        <Bold size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic">
        <Italic size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline">
        <UnderlineIcon size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough">
        <Strikethrough size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} title="Highlight">
        <Highlighter size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} title="Clear Formatting">
        <RemoveFormatting size={16} />
      </ToolButton>
      <div className="relative">
        <ToolButton onClick={() => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run()
          } else {
            setShowLinkInput(true)
            setTimeout(() => linkInputRef.current?.focus(), 50)
          }
        }} active={editor.isActive('link')} title="Insert Link">
          <Link size={16} />
        </ToolButton>
        {showLinkInput && (
          <div className="menu-surface anim-pop absolute top-full left-0 mt-1.5 z-30 flex items-center gap-1.5 p-1.5">
            <input
              ref={linkInputRef}
              type="url"
              value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && linkUrl.trim()) {
                  editor.chain().focus().setLink({ href: linkUrl.trim() }).run()
                  setLinkUrl('')
                  setShowLinkInput(false)
                } else if (e.key === 'Escape') {
                  setLinkUrl('')
                  setShowLinkInput(false)
                }
              }}
              placeholder="https://..."
              className="w-52 text-xs border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)] px-2.5 py-1.5 focus:outline-none focus:border-[var(--color-accent-text)] placeholder:text-[var(--color-text-muted)]"
            />
            <button
              onClick={() => {
                if (linkUrl.trim()) {
                  editor.chain().focus().setLink({ href: linkUrl.trim() }).run()
                }
                setLinkUrl('')
                setShowLinkInput(false)
              }}
              className="btn btn-primary"
            >
              OK
            </button>
          </div>
        )}
      </div>

      {/* Color picker */}
      <div className="relative">
        <input
          ref={colorInputRef}
          type="color"
          className="absolute opacity-0 w-0 h-0"
          onChange={e => editor.chain().focus().setColor(e.target.value).run()}
        />
        <ToolButton onClick={() => colorInputRef.current?.click()} title="Text Color">
          <Palette size={16} />
        </ToolButton>
      </div>

      <Divider />

      <ToolButton onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} title="Align Left">
        <AlignLeft size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} title="Align Center">
        <AlignCenter size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} title="Align Right">
        <AlignRight size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().setTextAlign('justify').run()} active={editor.isActive({ textAlign: 'justify' })} title="Justify">
        <AlignJustify size={16} />
      </ToolButton>

      <Divider />

      <ToolButton onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Heading 1">
        <Heading1 size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Heading 2">
        <Heading2 size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Heading 3">
        <Heading3 size={16} />
      </ToolButton>

      <Divider />

      <ToolButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List">
        <List size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Numbered List">
        <ListOrdered size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().sinkListItem('listItem').run()} title="Indent">
        <Indent size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().liftListItem('listItem').run()} title="Outdent">
        <Outdent size={16} />
      </ToolButton>

      <Divider />

      <ToolButton onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} title="Code Block">
        <Code size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} title="Blockquote">
        <Quote size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleSuperscript().run()} active={editor.isActive('superscript')} title="Superscript">
        <Superscript size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().toggleSubscript().run()} active={editor.isActive('subscript')} title="Subscript">
        <Subscript size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().setPageBreak().run()} title="Page Break">
        <SeparatorHorizontal size={16} />
      </ToolButton>
      <InsertTableDialog />
      <ToolButton onClick={() => {
        // Support both URL and local file upload
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return
          const reader = new FileReader()
          reader.onload = () => {
            const src = reader.result as string
            editor.chain().focus().setImage({ src }).run()
          }
          reader.readAsDataURL(file)
        }
        input.click()
      }} title="Insert Image">
        <ImageIcon size={16} />
      </ToolButton>

      <Divider />

      {/* Line spacing */}
      <select
        className="toolbar-select"
        defaultValue="1.5"
        onChange={e => {
          const page = document.querySelector('.document-page .ProseMirror') as HTMLElement
          if (page) page.style.lineHeight = e.target.value
        }}
        title="Line Spacing"
      >
        <option value="1">1.0</option>
        <option value="1.15">1.15</option>
        <option value="1.5">1.5</option>
        <option value="2">2.0</option>
        <option value="2.5">2.5</option>
        <option value="3">3.0</option>
      </select>

      {/* Page settings */}
      <PageSettingsDialog />

      <ToolButton onClick={() => editor.chain().focus().undo().run()} title="Undo">
        <Undo2 size={16} />
      </ToolButton>
      <ToolButton onClick={() => editor.chain().focus().redo().run()} title="Redo">
        <Redo2 size={16} />
      </ToolButton>

      <div className="flex-1" />

      {/* Import DOCX */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx"
        className="hidden"
        onChange={handleImport}
      />
      <ToolButton onClick={() => fileInputRef.current?.click()} title="Open DOCX">
        <Upload size={16} />
      </ToolButton>

      <ToolButton onClick={async () => {
        const html = editor.getHTML()
        const filename = `${documentTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}.docx`
        const pageSettings = getPageSettings()
        try {
          const res = await fetch(apiUrl('/api/export/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html_content: html, filename, page_settings: pageSettings }),
          })
          if (!res.ok) throw new Error('Export failed')
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = filename
          a.click()
          URL.revokeObjectURL(url)
          showToast(`Exported "${filename}"`, 'success')
        } catch {
          showToast('Export failed. Is the backend running?', 'error')
        }
      }} title="Export DOCX">
        <Download size={16} />
      </ToolButton>

      <ToolButton onClick={() => window.print()} title="Print">
        <Printer size={16} />
      </ToolButton>

      <FocusMode />
      <TableOfContents />
      <ApiKeyDialog />
      <ModelManager />
      <ThemeToggle />

      <ToolButton onClick={toggleAIPanel} title="AI Assistant">
        <MessageSquare size={16} />
      </ToolButton>
    </div>
  )
}
