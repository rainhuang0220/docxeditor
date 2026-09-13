export type TargetClass =
  | 'document'
  | 'document-end'
  | 'block-index'
  | 'cursor'
  | 'selection'

export interface RequestAnchor {
  from: number
  to: number
  cursor: number
  selectedText: string
}

export type ResolvedTarget =
  | { ok: true; class: TargetClass | 'unknown'; from?: number; to?: number; pos?: number }
  | { ok: false; class: TargetClass | 'unknown'; reason: string }

const DOCUMENT = new Set(['replace_content'])
const DOCUMENT_END = new Set(['insert_at_end'])
const BLOCK = new Set(['replace_paragraph', 'delete_paragraph', 'insert_after_paragraph'])
const CURSOR = new Set([
  'insert_at_cursor',
  'insert_table',
  'insert_list',
  'insert_horizontal_rule',
  'insert_blockquote',
  'insert_image',
  'insert_code_block',
])
const SELECTION = new Set([
  'replace_selection',
  'set_bold',
  'set_italic',
  'set_underline',
  'set_strikethrough',
  'set_highlight',
  'set_link',
  'set_heading',
  'set_align',
  'set_font_family',
  'set_font_size',
  'set_color',
])

export function operationTargetClass(type: string): TargetClass | 'unknown' {
  if (DOCUMENT.has(type)) return 'document'
  if (DOCUMENT_END.has(type)) return 'document-end'
  if (BLOCK.has(type)) return 'block-index'
  if (CURSOR.has(type)) return 'cursor'
  if (SELECTION.has(type)) return 'selection'
  return 'unknown'
}

export function resolveOpTarget(
  type: string,
  anchor: RequestAnchor,
  docSize: number,
): ResolvedTarget {
  const cls = operationTargetClass(type)
  if (cls === 'unknown') return { ok: true, class: 'unknown' }
  if (cls === 'document') return { ok: true, class: cls }
  if (cls === 'document-end') return { ok: true, class: cls, pos: docSize }
  if (cls === 'block-index') return { ok: true, class: cls }
  if (cls === 'cursor') {
    if (anchor.cursor < 0 || anchor.cursor > docSize) {
      return { ok: false, class: cls, reason: 'missing cursor anchor' }
    }
    return { ok: true, class: cls, pos: anchor.cursor }
  }
  if (type === 'replace_selection' && anchor.from === anchor.to) {
    return { ok: false, class: cls, reason: 'replace_selection requires a non-empty request selection' }
  }
  if (anchor.from < 0 || anchor.to < 0 || anchor.from > docSize || anchor.to > docSize) {
    return { ok: false, class: cls, reason: 'missing selection anchor' }
  }
  return { ok: true, class: cls, from: anchor.from, to: anchor.to }
}
