/**
 * Canonical AI operation contract (frontend).
 *
 * Backend `_tool_call_to_operation()` in backend/ai_service.py is the producer.
 * This module is the consumer: raw JSON is `unknown` until decodeOperations()
 * returns a normalized AiOperation[]. Extra producer fields
 * (`requires_confirmation`, `preview`, and anything else) are discarded.
 *
 * Not frontend operations:
 * - `read_blocks` — server-side only
 * - `format_selection` — converted to set_heading|set_align|set_font_*|set_color|set_* marks
 *
 * Backend may coerce a digit-string `paragraph_index` before it reaches us.
 * The frontend decoder does not coerce; it requires a real integer.
 *
 * Optional-field defaults match the backend conversion / tool schema:
 * - insert_table missing rows/cols → 3
 * - set_heading missing level → 1
 * - insert_image missing alt → ''
 * - insert_code_block missing language → ''
 * - set_align missing alignment → left
 * - set_font_family missing family → Arial
 * - set_font_size missing size → 14pt
 * - set_color missing color → #000000
 *
 * MAX_OPERATIONS = 80: MAX_AGENT_ROUNDS is 40 and a round can emit more than
 * one edit; 80 leaves room for a long-document formalize without allowing
 * pathological thousands-of-ops dumps.
 */

export const MAX_OPERATIONS = 80
export const MAX_TABLE_ROWS = 20
export const MAX_TABLE_COLS = 10
export const MAX_LIST_ITEMS = 100
export const MAX_PARAGRAPH_INDEX = 10_000
export const DEFAULT_TABLE_DIM = 3

export const INVALID_AI_EDIT_MESSAGE =
  'The AI returned an invalid document edit, so nothing was changed. Please retry.'

export type HeadingLevel = 1 | 2 | 3
export type Alignment = 'left' | 'center' | 'right' | 'justify'
export type ListType = 'ordered' | 'unordered'

export type AiOperation =
  | { type: 'replace_content'; content: string }
  | { type: 'insert_at_end'; content: string }
  | { type: 'insert_at_cursor'; content: string }
  | { type: 'insert_after_paragraph'; paragraph_index: number; content: string }
  | { type: 'replace_paragraph'; paragraph_index: number; content: string }
  | { type: 'delete_paragraph'; paragraph_index: number }
  | { type: 'replace_selection'; content: string }
  | { type: 'set_heading'; level: HeadingLevel }
  | { type: 'set_bold' }
  | { type: 'set_italic' }
  | { type: 'set_underline' }
  | { type: 'set_strikethrough' }
  | { type: 'set_highlight' }
  | { type: 'set_link'; href: string }
  | { type: 'set_align'; alignment: Alignment }
  | { type: 'set_font_family'; family: string }
  | { type: 'set_font_size'; size: string }
  | { type: 'set_color'; color: string }
  | { type: 'insert_table'; rows: number; cols: number }
  | { type: 'insert_list'; list_type: ListType; items: string[] }
  | { type: 'insert_horizontal_rule' }
  | { type: 'insert_code_block'; content: string; language: string }
  | { type: 'insert_blockquote'; content: string }
  | { type: 'insert_image'; src: string; alt: string }

export type DecodeResult =
  | { ok: true; operations: AiOperation[] }
  | { ok: false; reason: string }

const ALIGNMENTS = new Set<Alignment>(['left', 'center', 'right', 'justify'])
const LIST_TYPES = new Set<ListType>(['ordered', 'unordered'])
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const FONT_SIZE_RE = /^\d+(?:\.\d+)?pt$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(reason: string): DecodeResult {
  return { ok: false, reason }
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmptyTrimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function paragraphIndex(value: unknown): number | null {
  const n = integer(value)
  if (n === null || n < 0 || n > MAX_PARAGRAPH_INDEX) return null
  return n
}

function headingLevel(value: unknown): HeadingLevel | null {
  if (value === undefined) return 1
  if (value === 1 || value === 2 || value === 3) return value
  return null
}

function tableDim(value: unknown, max: number): number | null {
  if (value === undefined) return DEFAULT_TABLE_DIM
  const n = integer(value)
  if (n === null || n < 1 || n > max) return null
  return n
}

function decodeOne(raw: unknown): AiOperation | string {
  if (!isRecord(raw) || typeof raw.type !== 'string') return 'operation is not an object with a type'
  const type = raw.type
  switch (type) {
    case 'replace_content': {
      const content = requiredString(raw.content)
      if (content === null) return 'replace_content requires string content'
      return { type, content }
    }
    case 'insert_at_end':
    case 'insert_at_cursor':
    case 'insert_blockquote': {
      const content = nonEmptyTrimmed(raw.content)
      if (content === null) return `${type} requires non-empty string content`
      return { type, content }
    }
    case 'insert_after_paragraph': {
      const paragraph_index = paragraphIndex(raw.paragraph_index)
      const content = nonEmptyTrimmed(raw.content)
      if (paragraph_index === null) return 'insert_after_paragraph requires a valid paragraph_index'
      if (content === null) return 'insert_after_paragraph requires non-empty string content'
      return { type, paragraph_index, content }
    }
    case 'replace_paragraph': {
      const paragraph_index = paragraphIndex(raw.paragraph_index)
      const content = requiredString(raw.content)
      if (paragraph_index === null) return 'replace_paragraph requires a valid paragraph_index'
      if (content === null) return 'replace_paragraph requires string content'
      return { type, paragraph_index, content }
    }
    case 'delete_paragraph': {
      const paragraph_index = paragraphIndex(raw.paragraph_index)
      if (paragraph_index === null) return 'delete_paragraph requires a valid paragraph_index'
      return { type, paragraph_index }
    }
    case 'replace_selection': {
      const content = requiredString(raw.content)
      if (content === null) return 'replace_selection requires string content'
      return { type, content }
    }
    case 'set_heading': {
      const level = headingLevel(raw.level)
      if (level === null) return 'set_heading level must be 1, 2, or 3'
      return { type, level }
    }
    case 'set_bold':
    case 'set_italic':
    case 'set_underline':
    case 'set_strikethrough':
    case 'set_highlight':
    case 'insert_horizontal_rule':
      return { type }
    case 'set_link': {
      const href = nonEmptyTrimmed(raw.href)
      if (href === null) return 'set_link requires a non-empty href'
      return { type, href }
    }
    case 'set_align': {
      if (raw.alignment === undefined) return { type, alignment: 'left' }
      if (typeof raw.alignment !== 'string' || !ALIGNMENTS.has(raw.alignment as Alignment)) {
        return 'set_align alignment is invalid'
      }
      return { type, alignment: raw.alignment as Alignment }
    }
    case 'set_font_family': {
      if (raw.family === undefined) return { type, family: 'Arial' }
      const family = nonEmptyTrimmed(raw.family)
      if (family === null) return 'set_font_family requires a non-empty family'
      return { type, family }
    }
    case 'set_font_size': {
      if (raw.size === undefined) return { type, size: '14pt' }
      if (typeof raw.size !== 'string' || !FONT_SIZE_RE.test(raw.size)) return 'set_font_size must look like 14pt'
      return { type, size: raw.size }
    }
    case 'set_color': {
      if (raw.color === undefined) return { type, color: '#000000' }
      if (typeof raw.color !== 'string' || !COLOR_RE.test(raw.color)) return 'set_color must be #RGB or #RRGGBB'
      return { type, color: raw.color }
    }
    case 'insert_table': {
      const rows = tableDim(raw.rows, MAX_TABLE_ROWS)
      const cols = tableDim(raw.cols, MAX_TABLE_COLS)
      if (rows === null || cols === null) return 'insert_table rows/cols are out of range'
      return { type, rows, cols }
    }
    case 'insert_list': {
      if (typeof raw.list_type !== 'string' || !LIST_TYPES.has(raw.list_type as ListType)) {
        return 'insert_list list_type is invalid'
      }
      if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_LIST_ITEMS) {
        return 'insert_list items must be a non-empty string array'
      }
      if (!raw.items.every(item => typeof item === 'string')) return 'insert_list items must be strings'
      return { type, list_type: raw.list_type as ListType, items: [...raw.items] }
    }
    case 'insert_code_block': {
      const content = requiredString(raw.content)
      if (content === null) return 'insert_code_block requires string content'
      const language = raw.language === undefined ? '' : requiredString(raw.language)
      if (language === null) return 'insert_code_block language must be a string'
      return { type, content, language }
    }
    case 'insert_image': {
      const src = nonEmptyTrimmed(raw.src)
      if (src === null) return 'insert_image requires a non-empty src'
      if (raw.alt === undefined) return { type, src, alt: '' }
      const alt = requiredString(raw.alt)
      if (alt === null) return 'insert_image alt must be a string'
      return { type, src, alt }
    }
    default:
      return `unknown operation type: ${type}`
  }
}

export function decodeOperations(raw: unknown): DecodeResult {
  if (!Array.isArray(raw)) return fail('operations must be an array')
  if (raw.length > MAX_OPERATIONS) return fail(`batch exceeds MAX_OPERATIONS (${MAX_OPERATIONS})`)
  const operations: AiOperation[] = []
  for (const item of raw) {
    const decoded = decodeOne(item)
    if (typeof decoded === 'string') return fail(decoded)
    operations.push(decoded)
  }
  return { ok: true, operations }
}
