import { createDocument } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'

const PARSE = { preserveWhitespace: true as const }

/**
 * Apply HTML via TipTap setContent and confirm the live document equals the
 * intended parsed node. TipTap appends an empty paragraph after a trailing
 * list or table; that normalization still counts. Anything else is rolled back.
 */
export function applyVerifiedReplacement(editor: Editor, nextHtml: string): boolean {
  let intended
  try {
    intended = createDocument(nextHtml, editor.schema, PARSE)
  } catch {
    return false
  }
  const before = editor.getJSON()
  editor.commands.setContent(nextHtml, { parseOptions: PARSE })
  if (editor.state.doc.eq(intended) || editor.state.doc.eq(withTrailingEmptyParagraph(intended))) return true
  editor.commands.setContent(before)
  return false
}

function withTrailingEmptyParagraph(doc: ReturnType<typeof createDocument>) {
  const last = doc.lastChild
  if (last?.type.name === 'paragraph' && last.content.size === 0) return doc
  const paragraph = doc.type.schema.nodes.paragraph?.create()
  if (!paragraph) return doc
  return doc.type.create(doc.attrs, doc.content.append(Fragment.from(paragraph)))
}
