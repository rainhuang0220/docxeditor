import type { RequestContext } from './requestContext.ts'
import { resolveOpTarget } from './operationTarget.ts'

function asBlockIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return null
}

function topLevelBlockRange(editor: { state: { doc: { forEach: (fn: (node: { nodeSize: number }, offset: number) => void) => void } } }, index: number): { from: number; to: number } | null {
  let cur = 0
  let result: { from: number; to: number } | null = null
  editor.state.doc.forEach((node, offset) => {
    if (cur === index) result = { from: offset, to: offset + node.nodeSize }
    cur++
  })
  return result
}

export function planOperations(
  ops: any[],
  ctx: RequestContext,
  docSize: number,
): { ok: true } | { ok: false; reason: string } {
  for (const op of ops) {
    const type = String(op?.type || '')
    const resolved = resolveOpTarget(type, ctx.anchor, docSize)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
  }
  return { ok: true }
}

function applyOperation(editor: any, op: any, ctx: RequestContext): void {
  const docSize = editor.state.doc.content.size
  const target = resolveOpTarget(String(op.type || ''), ctx.anchor, docSize)
  if (!target.ok) throw new Error(target.reason)

  switch (op.type) {
    case 'replace_content':
      editor.commands.setContent(op.content || '', { parseOptions: { preserveWhitespace: true } })
      break
    case 'insert_at_end':
      editor.chain().insertContentAt(editor.state.doc.content.size, op.content).run()
      break
    case 'insert_at_cursor':
      editor.chain().insertContentAt(target.pos!, op.content).run()
      break
    case 'insert_after_paragraph': {
      const range = topLevelBlockRange(editor, op.paragraph_index ?? 0)
      const pos = range ? range.to : editor.state.doc.content.size
      editor.chain().insertContentAt(pos, op.content).run()
      break
    }
    case 'replace_paragraph': {
      const range = topLevelBlockRange(editor, op.paragraph_index ?? 0)
      if (range) {
        editor.chain().deleteRange(range).insertContentAt(range.from, op.content).run()
      } else {
        editor.chain().insertContentAt(editor.state.doc.content.size, op.content).run()
      }
      break
    }
    case 'delete_paragraph': {
      const range = topLevelBlockRange(editor, op.paragraph_index ?? 0)
      if (range) editor.chain().deleteRange(range).run()
      break
    }
    case 'set_heading': {
      const level = op.level || 1
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).toggleHeading({ level }).run()
      break
    }
    case 'set_bold':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).toggleBold().run()
      break
    case 'set_italic':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).toggleItalic().run()
      break
    case 'set_underline':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).toggleUnderline().run()
      break
    case 'set_strikethrough':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).toggleStrike().run()
      break
    case 'set_highlight':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).toggleHighlight().run()
      break
    case 'set_link':
      if (op.href) {
        editor.chain().setTextSelection({ from: target.from!, to: target.to! }).setLink({ href: op.href }).run()
      }
      break
    case 'set_align':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).setTextAlign(op.alignment).run()
      break
    case 'set_font_family':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).setFontFamily(op.family).run()
      break
    case 'set_font_size':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).setFontSize(op.size).run()
      break
    case 'set_color':
      editor.chain().setTextSelection({ from: target.from!, to: target.to! }).setColor(op.color).run()
      break
    case 'insert_table':
      editor.chain().setTextSelection(target.pos!).insertTable({
        rows: op.rows || 3,
        cols: op.cols || 3,
        withHeaderRow: true,
      }).run()
      break
    case 'insert_image':
      if (op.src) {
        editor.chain().setTextSelection(target.pos!).setImage({ src: op.src, alt: op.alt || '' }).run()
      }
      break
    case 'insert_horizontal_rule':
      editor.chain().setTextSelection(target.pos!).setHorizontalRule().run()
      break
    case 'insert_blockquote':
      editor.chain().insertContentAt(target.pos!, `<blockquote><p>${op.content || ''}</p></blockquote>`).run()
      break
    case 'insert_list': {
      const items = op.items || []
      const listType = op.list_type === 'ordered' ? 'ol' : 'ul'
      const html = `<${listType}>${items.map((i: string) => `<li><p>${i}</p></li>`).join('')}</${listType}>`
      editor.chain().insertContentAt(target.pos!, html).run()
      break
    }
    case 'insert_code_block':
      editor.chain().setTextSelection(target.pos!).toggleCodeBlock().run()
      if (op.content) {
        editor.chain().insertContentAt(target.pos!, op.content).run()
      }
      break
    case 'replace_selection':
      editor.chain().deleteRange({ from: target.from!, to: target.to! }).insertContentAt(target.from!, op.content).run()
      break
    default:
      console.warn('Unknown operation:', op.type)
      break
  }
}

export function applyOperationBatch(editor: any, ops: any[], ctx: RequestContext): { ok: true } | { ok: false; reason: string } {
  const docSize = editor.state.doc.content.size
  const planned = planOperations(ops, ctx, docSize)
  if (!planned.ok) return planned
  const normalized = ops.map(op => {
    const idx = asBlockIndex(op?.paragraph_index)
    return idx === null ? op : { ...op, paragraph_index: idx }
  })
  const indexed = normalized
    .filter(op => typeof op.paragraph_index === 'number')
    .sort((a, b) => b.paragraph_index - a.paragraph_index)
  const rest = normalized.filter(op => typeof op.paragraph_index !== 'number')
  for (const op of indexed) applyOperation(editor, op, ctx)
  for (const op of rest) applyOperation(editor, op, ctx)
  return { ok: true }
}
