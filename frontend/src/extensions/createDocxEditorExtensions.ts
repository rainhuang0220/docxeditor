import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Image from '@tiptap/extension-image'
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
import { FontSize } from './FontSize.ts'
import { KeyboardShortcuts } from './KeyboardShortcuts.ts'
import { ClipboardExtension } from './ClipboardSupport.ts'
import { PageBreak } from './PageBreak.ts'
import { ReviewLock } from './ReviewLock.ts'
import { DocumentRevision } from './DocumentRevision.ts'
import type { Extensions } from '@tiptap/core'

export const CustomTableCell = TableCell.extend({
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

export type EditorEnvironment = 'interactive' | 'headless'

/** Test-only: omit schema pieces so a later TipTap command returns false. Production never passes this. */
export type HeadlessWithout =
  | 'table'
  | 'image'
  | 'codeBlock'
  | 'horizontalRule'
  | 'highlight'
  | 'link'

export interface CreateDocxEditorExtensionsOptions {
  isLocked?: () => boolean
  environment?: EditorEnvironment
  without?: readonly HeadlessWithout[]
}

/**
 * Shared TipTap extension list for the React editor and headless AI apply tests.
 *
 * Headless drops clipboard, keyboard chrome, placeholder, and ImageResize NodeViews.
 * Schema for AI operations stays the same unless `without` is set (tests only).
 */
export function createDocxEditorExtensions(options: CreateDocxEditorExtensionsOptions = {}): Extensions {
  const environment = options.environment ?? 'interactive'
  const without = new Set(options.without ?? [])
  const isLocked = options.isLocked ?? (() => false)
  const headless = environment === 'headless'

  const extensions: Extensions = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Link and Underline are registered explicitly below (same as the
      // production editor's extra extensions).
      link: false,
      underline: false,
      dropcursor: headless ? false : undefined,
      gapcursor: headless ? false : undefined,
      codeBlock: without.has('codeBlock') ? false : undefined,
      horizontalRule: without.has('horizontalRule') ? false : undefined,
    }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Underline,
    TextStyle,
    Color,
  ]

  if (!without.has('image')) {
    extensions.push(
      headless
        ? Image.configure({ inline: false })
        : ImageResize.configure({ inline: false }),
    )
  }
  if (!without.has('table')) {
    extensions.push(
      Table.configure({ resizable: !headless }),
      TableRow,
      CustomTableCell,
      TableHeader,
    )
  }

  extensions.push(FontFamily, FontSize)

  if (!headless) {
    extensions.push(KeyboardShortcuts, ClipboardExtension)
  }

  if (!without.has('link')) {
    extensions.push(Link.configure({ openOnClick: false }))
  }
  if (!without.has('highlight')) {
    extensions.push(Highlight.configure({ multicolor: true }))
  }

  extensions.push(Superscript, Subscript)

  if (!headless) {
    extensions.push(Placeholder.configure({ placeholder: 'Start typing your document...' }))
  }

  extensions.push(
    PageBreak,
    ReviewLock.configure({ isLocked }),
    DocumentRevision,
  )

  return extensions
}
