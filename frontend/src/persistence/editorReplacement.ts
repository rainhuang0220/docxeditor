import { createDocument } from '@tiptap/core'
import type { Editor } from '@tiptap/core'

const PARSE = { preserveWhitespace: true as const }

/**
 * Apply HTML via TipTap setContent and confirm the live document equals the
 * intended parsed node. Command booleans are not trusted: ReviewLock can
 * filter the transaction after setContent returns true.
 */
export function applyVerifiedReplacement(editor: Editor, nextHtml: string): boolean {
  let intended
  try {
    intended = createDocument(nextHtml, editor.schema, PARSE)
  } catch {
    return false
  }
  editor.commands.setContent(nextHtml, { parseOptions: PARSE })
  return editor.state.doc.eq(intended)
}
