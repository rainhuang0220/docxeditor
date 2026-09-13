import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_OPERATIONS,
  decodeOperations,
  type AiOperation,
} from './operations.ts'

function okOps(raw: unknown): AiOperation[] {
  const decoded = decodeOperations(raw)
  assert.equal(decoded.ok, true, decoded.ok === false ? decoded.reason : '')
  if (!decoded.ok) throw new Error('expected decode success')
  return decoded.operations
}

function reject(raw: unknown): void {
  const decoded = decodeOperations(raw)
  assert.equal(decoded.ok, false)
}

const LEGITIMATE: unknown[] = [
  { type: 'replace_content', content: '<p>All</p>' },
  { type: 'insert_at_cursor', content: '<p>Here</p>' },
  { type: 'insert_at_end', content: '<p>End</p>' },
  { type: 'insert_after_paragraph', paragraph_index: 0, content: '<p>After</p>' },
  { type: 'replace_paragraph', paragraph_index: 0, content: '<p>New</p>' },
  { type: 'delete_paragraph', paragraph_index: 0 },
  { type: 'replace_selection', content: '<p>Sel</p>' },
  { type: 'insert_table', rows: 3, cols: 3 },
  { type: 'insert_list', list_type: 'ordered', items: ['a', 'b'] },
  { type: 'insert_horizontal_rule' },
  { type: 'insert_code_block', content: 'print(1)', language: 'python' },
  { type: 'insert_blockquote', content: 'quote' },
  { type: 'insert_image', src: 'https://example.com/a.png', alt: 'pic' },
  { type: 'set_link', href: 'https://example.com' },
  { type: 'set_heading', level: 2 },
  { type: 'set_align', alignment: 'center' },
  { type: 'set_font_family', family: 'Arial' },
  { type: 'set_font_size', size: '14pt' },
  { type: 'set_color', color: '#ff0000' },
  { type: 'set_bold' },
  { type: 'set_italic' },
  { type: 'set_underline' },
  { type: 'set_strikethrough' },
  { type: 'set_highlight' },
]

test('case 1: every legitimate backend operation shape decodes successfully', () => {
  const ops = okOps(LEGITIMATE)
  assert.equal(ops.length, LEGITIMATE.length)
  assert.deepEqual(ops.map(op => op.type), LEGITIMATE.map(op => (op as { type: string }).type))
})

test('case 1b: backend defaults for optional table/heading/image/code fields decode', () => {
  const ops = okOps([
    { type: 'insert_table' },
    { type: 'set_heading' },
    { type: 'insert_image', src: 'https://example.com/a.png' },
    { type: 'insert_code_block', content: 'x' },
  ])
  assert.deepEqual(ops[0], { type: 'insert_table', rows: 3, cols: 3 })
  assert.deepEqual(ops[1], { type: 'set_heading', level: 1 })
  assert.deepEqual(ops[2], { type: 'insert_image', src: 'https://example.com/a.png', alt: '' })
  assert.deepEqual(ops[3], { type: 'insert_code_block', content: 'x', language: '' })
})

test('case 2: unknown type rejected', () => {
  reject([{ type: 'magic_rewrite', content: 'x' }])
  reject([{ type: 'format_selection', action: 'bold' }])
  reject([{ type: 'read_blocks', start_index: 0, end_index: 1 }])
})

test('case 3: missing required field rejected', () => {
  reject([{ type: 'replace_content' }])
  reject([{ type: 'insert_at_cursor' }])
  reject([{ type: 'replace_paragraph', paragraph_index: 0 }])
  reject([{ type: 'replace_paragraph', content: '<p>x</p>' }])
  reject([{ type: 'delete_paragraph' }])
  reject([{ type: 'insert_image' }])
  reject([{ type: 'set_link' }])
  reject([{ type: 'insert_list', list_type: 'ordered' }])
  reject([{ type: 'insert_blockquote' }])
})

test('case 4: wrong field type rejected', () => {
  reject([{ type: 'replace_content', content: 12 }])
  reject([{ type: 'replace_paragraph', paragraph_index: '0', content: '<p>x</p>' }])
  reject([{ type: 'insert_table', rows: '3', cols: 3 }])
  reject([{ type: 'insert_list', list_type: 'ordered', items: 'a' }])
  reject([{ type: 'set_heading', level: '2' }])
  reject([{ type: 'set_align', alignment: 1 }])
})

test('case 5: invalid enum rejected', () => {
  reject([{ type: 'set_align', alignment: 'middle' }])
  reject([{ type: 'insert_list', list_type: 'checklist', items: ['a'] }])
  reject([{ type: 'set_heading', level: 4 }])
  reject([{ type: 'set_heading', level: 0 }])
})

test('case 6: invalid numeric range rejected', () => {
  reject([{ type: 'replace_paragraph', paragraph_index: -1, content: '<p>x</p>' }])
  reject([{ type: 'replace_paragraph', paragraph_index: 1.5, content: '<p>x</p>' }])
  reject([{ type: 'replace_paragraph', paragraph_index: Number.NaN, content: '<p>x</p>' }])
  reject([{ type: 'replace_paragraph', paragraph_index: Number.POSITIVE_INFINITY, content: '<p>x</p>' }])
  reject([{ type: 'insert_table', rows: 0, cols: 3 }])
  reject([{ type: 'insert_table', rows: 3, cols: 0 }])
  reject([{ type: 'insert_table', rows: -2, cols: 3 }])
  reject([{ type: 'insert_table', rows: 21, cols: 3 }])
  reject([{ type: 'insert_table', rows: 3, cols: 11 }])
  reject([{ type: 'delete_paragraph', paragraph_index: 10001 }])
})

test('case 7: over-limit batch rejected', () => {
  const ops = Array.from({ length: MAX_OPERATIONS + 1 }, () => ({ type: 'set_bold' }))
  reject(ops)
  assert.equal(okOps(Array.from({ length: MAX_OPERATIONS }, () => ({ type: 'set_bold' }))).length, MAX_OPERATIONS)
})

test('case 8: decoder returns normalized typed operations, not raw aliases/objects', () => {
  const raw = {
    type: 'replace_paragraph',
    paragraph_index: 2,
    content: '<p>x</p>',
    extra: 'leak',
    requires_confirmation: true,
    preview: 'nope',
  }
  const [op] = okOps([raw])
  assert.notEqual(op, raw)
  assert.deepEqual(op, { type: 'replace_paragraph', paragraph_index: 2, content: '<p>x</p>' })
  assert.equal('extra' in op, false)
  assert.equal('requires_confirmation' in op, false)
})

test('case 14: malformed index cannot become 0', () => {
  reject([{ type: 'replace_paragraph', paragraph_index: 'nope', content: '<p>x</p>' }])
  reject([{ type: 'replace_paragraph', paragraph_index: null, content: '<p>x</p>' }])
  reject([{ type: 'replace_paragraph', paragraph_index: undefined, content: '<p>x</p>' }])
  reject([{ type: 'replace_paragraph', paragraph_index: true, content: '<p>x</p>' }])
  reject([{ type: 'delete_paragraph', paragraph_index: '' }])
})

test('empty insert payloads rejected; empty replace content allowed', () => {
  reject([{ type: 'insert_at_end', content: '' }])
  reject([{ type: 'insert_at_cursor', content: '   ' }])
  reject([{ type: 'insert_after_paragraph', paragraph_index: 0, content: '' }])
  reject([{ type: 'insert_image', src: '', alt: 'x' }])
  reject([{ type: 'set_link', href: '' }])
  reject([{ type: 'insert_list', list_type: 'unordered', items: [] }])
  const replaced = okOps([
    { type: 'replace_content', content: '' },
    { type: 'replace_paragraph', paragraph_index: 0, content: '' },
    { type: 'replace_selection', content: '' },
  ])
  assert.equal(replaced[0].type, 'replace_content')
})

test('case 38: unknown operation in otherwise-valid batch rejects entire batch', () => {
  reject([
    { type: 'set_bold' },
    { type: 'magic_rewrite', content: 'x' },
  ])
})

test('case 39: malformed table rejected', () => {
  reject([{ type: 'insert_table', rows: 3.2, cols: 3 }])
  reject([{ type: 'insert_table', rows: 3, cols: null }])
})

test('case 40: malformed list rejected', () => {
  reject([{ type: 'insert_list', list_type: 'ordered', items: [1, 2] }])
  reject([{ type: 'insert_list', list_type: 'ordered', items: ['a', null] }])
})

test('case 41: malformed image/link payload rejected', () => {
  reject([{ type: 'insert_image', src: 12 }])
  reject([{ type: 'set_link', href: { url: 'x' } }])
  reject([{ type: 'set_color', color: 'red' }])
  reject([{ type: 'set_font_size', size: '14' }])
})

test('case 42: pathological operation count rejected', () => {
  reject(Array.from({ length: 500 }, () => ({ type: 'insert_at_end', content: '<p>x</p>' })))
})

test('non-array operations payload rejected', () => {
  reject(null)
  reject({ type: 'set_bold' })
  reject('set_bold')
})
