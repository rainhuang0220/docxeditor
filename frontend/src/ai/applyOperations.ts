import { Fragment, type Node, type Schema } from '@tiptap/pm/model'
import { type EditorState, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import type { RequestContext } from './requestContext.ts'
import { resolveOpTarget } from './operationTarget.ts'
import {
  decodeOperations,
  type AiOperation,
} from './operations.ts'

export type ResolvedTarget =
  | { class: 'document' }
  | { class: 'document-end'; pos: number }
  | { class: 'block-index'; index: number; from: number; to: number }
  | { class: 'cursor'; pos: number }
  | { class: 'selection'; from: number; to: number }

export interface ResolvedStep {
  op: AiOperation
  target: ResolvedTarget
}

export interface ResolvedPlan {
  steps: ResolvedStep[]
}

export type PlanResult =
  | { ok: true; plan: ResolvedPlan }
  | { ok: false; reason: string }

export type ExecuteResult =
  | { ok: true; operations: AiOperation[] }
  | { ok: false; reason: string }

type CommandMap = Record<string, (...args: unknown[]) => boolean>

export interface AtomicEditor {
  readonly state: EditorState
  readonly schema: Schema
  readonly view: {
    dispatch: (tr: Transaction) => void
    readonly state: EditorState
  }
}

interface TipTapChain {
  command: (fn: (props: { tr: Transaction; commands: CommandMap }) => boolean) => { run: () => boolean }
}

function tipTapChain(editor: AtomicEditor): TipTapChain | null {
  const chain = (editor as AtomicEditor & { chain?: () => TipTapChain }).chain
  if (typeof chain !== 'function') return null
  return chain.call(editor)
}

function fail(reason: string): PlanResult {
  return { ok: false, reason }
}

function topLevelBlockRange(doc: Node, index: number): { from: number; to: number } | null {
  if (!Number.isInteger(index) || index < 0) return null
  let cur = 0
  let result: { from: number; to: number } | null = null
  doc.forEach((node, offset) => {
    if (cur === index) result = { from: offset, to: offset + node.nodeSize }
    cur++
  })
  return result
}

function isFormatting(type: AiOperation['type']): boolean {
  return (
    type === 'set_bold' ||
    type === 'set_italic' ||
    type === 'set_underline' ||
    type === 'set_strikethrough' ||
    type === 'set_highlight' ||
    type === 'set_link' ||
    type === 'set_heading' ||
    type === 'set_align' ||
    type === 'set_font_family' ||
    type === 'set_font_size' ||
    type === 'set_color'
  )
}

function rangeOfIndex(doc: Node, index: number): { from: number; to: number } | null {
  return topLevelBlockRange(doc, index)
}

function posInside(range: { from: number; to: number }, pos: number): boolean {
  return pos > range.from && pos < range.to
}

function rangesOverlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < b.to && b.from < a.to
}

/**
 * Resolve every target against the request-time document, then reject
 * ambiguous batches. Plan order is emission order; nothing is re-sorted.
 */
export function planOperations(
  ops: readonly AiOperation[],
  ctx: RequestContext,
  originalDoc: Node,
): PlanResult {
  const docSize = originalDoc.content.size
  const blockCount = originalDoc.childCount
  const steps: ResolvedStep[] = []
  const destroyed = new Map<number, 'replace' | 'delete'>()
  let sawReplaceContent = false

  for (const op of ops) {
    if (op.type === 'replace_content') {
      if (sawReplaceContent || steps.length > 0) {
        return fail('replace_content cannot be mixed with other operations')
      }
      sawReplaceContent = true
      steps.push({ op, target: { class: 'document' } })
      continue
    }
    if (sawReplaceContent) {
      return fail('replace_content cannot be mixed with other operations')
    }

    if (op.type === 'replace_paragraph' || op.type === 'delete_paragraph' || op.type === 'insert_after_paragraph') {
      if (op.paragraph_index >= blockCount) {
        return fail(`block index ${op.paragraph_index} is out of range`)
      }
      const range = rangeOfIndex(originalDoc, op.paragraph_index)
      if (!range) return fail(`block index ${op.paragraph_index} cannot be resolved`)
      if (op.type === 'replace_paragraph' || op.type === 'delete_paragraph') {
        if (destroyed.has(op.paragraph_index)) {
          return fail('conflicting destructive edits to the same original block')
        }
        destroyed.set(op.paragraph_index, op.type === 'delete_paragraph' ? 'delete' : 'replace')
      } else if (destroyed.get(op.paragraph_index) === 'delete') {
        return fail('insert_after a deleted original block is ambiguous')
      }
      steps.push({
        op,
        target: { class: 'block-index', index: op.paragraph_index, from: range.from, to: range.to },
      })
      continue
    }

    const resolved = resolveOpTarget(op.type, ctx.anchor, docSize)
    if (!resolved.ok) return fail(resolved.reason)
    if (resolved.class === 'cursor' && resolved.pos !== undefined) {
      steps.push({ op, target: { class: 'cursor', pos: resolved.pos } })
      continue
    }
    if (resolved.class === 'selection' && resolved.from !== undefined && resolved.to !== undefined) {
      steps.push({ op, target: { class: 'selection', from: resolved.from, to: resolved.to } })
      continue
    }
    if (resolved.class === 'document-end' && resolved.pos !== undefined) {
      steps.push({ op, target: { class: 'document-end', pos: resolved.pos } })
      continue
    }
    return fail(`could not resolve target for ${op.type}`)
  }

  const destroyedRanges: { from: number; to: number }[] = []
  for (const index of destroyed.keys()) {
    const range = rangeOfIndex(originalDoc, index)
    if (range) destroyedRanges.push(range)
  }

  for (const step of steps) {
    const target = step.target
    if (target.class === 'cursor' && destroyedRanges.some(range => posInside(range, target.pos))) {
      return fail('cursor target sits inside a destroyed original block')
    }
    if (target.class === 'selection' && destroyedRanges.some(range => rangesOverlap(range, target))) {
      return fail('selection target overlaps a destroyed original block')
    }
  }

  const hasReplaceSelection = steps.some(step => step.op.type === 'replace_selection')
  if (hasReplaceSelection && steps.length > 1) {
    const others = steps.filter(step => step.op.type !== 'replace_selection')
    const selection = steps.find(step => step.op.type === 'replace_selection')
    if (selection && selection.target.class === 'selection') {
      for (const other of others) {
        if (other.target.class === 'selection') {
          return fail('replace_selection cannot mix with other selection operations')
        }
        if (other.target.class === 'cursor' && posInside(selection.target, other.target.pos)) {
          return fail('replace_selection cannot mix with a cursor operation inside the selection')
        }
      }
    }
  }

  return { ok: true, plan: { steps } }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function htmlToNodes(schema: Schema, html: string): Node[] {
  const source = html.trim()
  if (!source) return [schema.node('paragraph')]
  const nodes: Node[] = []
  const re = /<(p|h[1-3]|blockquote)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi
  let matched = false
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    matched = true
    const tag = m[1].toLowerCase()
    const text = stripTags(m[2])
    const inline = text ? [schema.text(text)] : []
    if (tag.startsWith('h') && schema.nodes.heading) {
      nodes.push(schema.node('heading', { level: Number(tag.slice(1)) }, inline))
    } else if (tag === 'blockquote' && schema.nodes.blockquote) {
      nodes.push(schema.node('blockquote', null, [schema.node('paragraph', null, inline)]))
    } else {
      nodes.push(schema.node('paragraph', null, inline))
    }
  }
  if (!matched) {
    const text = stripTags(source)
    nodes.push(schema.node('paragraph', null, text ? [schema.text(text)] : []))
  }
  return nodes
}

function mappedRange(tr: Transaction, from: number, to: number): { from: number; to: number } | null {
  const start = tr.mapping.map(from, -1)
  const end = tr.mapping.map(to, 1)
  if (start > end) return null
  return { from: start, to: end }
}

function callCmd(commands: CommandMap, name: string, ...args: unknown[]): boolean {
  const fn = commands[name]
  return typeof fn === 'function' ? fn(...args) === true : false
}

function applyFormattingCommands(
  commands: CommandMap,
  op: AiOperation,
  from: number,
  to: number,
): boolean {
  if (!callCmd(commands, 'setTextSelection', { from, to })) return false
  switch (op.type) {
    case 'set_bold':
      return callCmd(commands, 'setBold') || callCmd(commands, 'toggleBold')
    case 'set_italic':
      return callCmd(commands, 'setItalic') || callCmd(commands, 'toggleItalic')
    case 'set_underline':
      return callCmd(commands, 'setUnderline') || callCmd(commands, 'toggleUnderline')
    case 'set_strikethrough':
      return callCmd(commands, 'setStrike') || callCmd(commands, 'toggleStrike')
    case 'set_highlight':
      return callCmd(commands, 'setHighlight') || callCmd(commands, 'toggleHighlight')
    case 'set_link':
      return callCmd(commands, 'setLink', { href: op.href })
    case 'set_heading':
      return callCmd(commands, 'setHeading', { level: op.level }) || callCmd(commands, 'toggleHeading', { level: op.level })
    case 'set_align':
      return callCmd(commands, 'setTextAlign', op.alignment)
    case 'set_font_family':
      return callCmd(commands, 'setFontFamily', op.family)
    case 'set_font_size':
      return callCmd(commands, 'setFontSize', op.size)
    case 'set_color':
      return callCmd(commands, 'setColor', op.color)
    default:
      return false
  }
}

function applyStepWithCommands(tr: Transaction, commands: CommandMap, step: ResolvedStep): boolean {
  const { op, target } = step
  const parse = { parseOptions: { preserveWhitespace: true } }
  if (op.type === 'replace_content' && target.class === 'document') {
    return callCmd(commands, 'setContent', op.content, parse)
  }
  if (target.class === 'block-index') {
    const range = mappedRange(tr, target.from, target.to)
    if (!range) return false
    if (op.type === 'delete_paragraph') return callCmd(commands, 'deleteRange', range)
    if (op.type === 'replace_paragraph') {
      return callCmd(commands, 'insertContentAt', { from: range.from, to: range.to }, op.content, parse)
    }
    if (op.type === 'insert_after_paragraph') {
      const pos = tr.mapping.map(target.to, 1)
      return callCmd(commands, 'insertContentAt', pos, op.content, parse)
    }
  }
  if (target.class === 'document-end' && op.type === 'insert_at_end') {
    return callCmd(commands, 'insertContentAt', tr.mapping.map(target.pos, 1), op.content, parse)
  }
  if (target.class === 'cursor') {
    const pos = tr.mapping.map(target.pos)
    if (op.type === 'insert_at_cursor') return callCmd(commands, 'insertContentAt', pos, op.content, parse)
    if (op.type === 'insert_table') {
      return callCmd(commands, 'setTextSelection', pos) && callCmd(commands, 'insertTable', {
        rows: op.rows,
        cols: op.cols,
        withHeaderRow: true,
      })
    }
    if (op.type === 'insert_image') {
      return callCmd(commands, 'setTextSelection', pos) && callCmd(commands, 'setImage', { src: op.src, alt: op.alt })
    }
    if (op.type === 'insert_horizontal_rule') {
      return callCmd(commands, 'setTextSelection', pos) && callCmd(commands, 'setHorizontalRule')
    }
    if (op.type === 'insert_blockquote') {
      return callCmd(commands, 'insertContentAt', pos, `<blockquote><p>${op.content}</p></blockquote>`, parse)
    }
    if (op.type === 'insert_list') {
      const listType = op.list_type === 'ordered' ? 'ol' : 'ul'
      const html = `<${listType}>${op.items.map(item => `<li><p>${item}</p></li>`).join('')}</${listType}>`
      return callCmd(commands, 'insertContentAt', pos, html, parse)
    }
    if (op.type === 'insert_code_block') {
      if (!callCmd(commands, 'setTextSelection', pos)) return false
      if (!callCmd(commands, 'setCodeBlock') && !callCmd(commands, 'toggleCodeBlock')) return false
      if (!op.content) return true
      return callCmd(commands, 'insertContent', op.content)
    }
  }
  if (target.class === 'selection') {
    const range = mappedRange(tr, target.from, target.to)
    if (!range) return false
    if (op.type === 'replace_selection') {
      return callCmd(commands, 'insertContentAt', { from: range.from, to: range.to }, op.content, parse)
    }
    if (isFormatting(op.type)) return applyFormattingCommands(commands, op, range.from, range.to)
  }
  return false
}

function applyMark(tr: Transaction, schema: Schema, name: string, from: number, to: number, attrs?: Record<string, unknown>): boolean {
  const markType = schema.marks[name]
  if (!markType) return false
  tr.addMark(from, to, markType.create(attrs))
  return true
}

function applyStepToTransaction(tr: Transaction, schema: Schema, step: ResolvedStep): boolean {
  const { op, target } = step
  if (op.type === 'replace_content' && target.class === 'document') {
    tr.replaceWith(0, tr.doc.content.size, Fragment.from(htmlToNodes(schema, op.content)))
    return true
  }
  if (target.class === 'block-index') {
    const range = mappedRange(tr, target.from, target.to)
    if (!range) return false
    if (op.type === 'delete_paragraph') {
      if (tr.doc.childCount <= 1) return false
      tr.delete(range.from, range.to)
      return true
    }
    if (op.type === 'replace_paragraph') {
      tr.replaceWith(range.from, range.to, Fragment.from(htmlToNodes(schema, op.content)))
      return true
    }
    if (op.type === 'insert_after_paragraph') {
      const pos = tr.mapping.map(target.to, 1)
      tr.insert(pos, Fragment.from(htmlToNodes(schema, op.content)))
      return true
    }
  }
  if (target.class === 'document-end' && op.type === 'insert_at_end') {
    tr.insert(tr.mapping.map(target.pos, 1), Fragment.from(htmlToNodes(schema, op.content)))
    return true
  }
  if (target.class === 'cursor') {
    const pos = tr.mapping.map(target.pos)
    if (op.type === 'insert_at_cursor') {
      tr.insert(pos, Fragment.from(htmlToNodes(schema, op.content)))
      return true
    }
    if (
      op.type === 'insert_table' ||
      op.type === 'insert_image' ||
      op.type === 'insert_horizontal_rule' ||
      op.type === 'insert_list' ||
      op.type === 'insert_code_block' ||
      op.type === 'insert_blockquote'
    ) {
      return false
    }
  }
  if (target.class === 'selection') {
    const range = mappedRange(tr, target.from, target.to)
    if (!range) return false
    if (op.type === 'replace_selection') {
      const text = stripTags(op.content)
      tr.insertText(text, range.from, range.to)
      return true
    }
    if (op.type === 'set_bold') return applyMark(tr, schema, 'bold', range.from, range.to)
    if (op.type === 'set_italic') return applyMark(tr, schema, 'italic', range.from, range.to)
    if (op.type === 'set_underline') return applyMark(tr, schema, 'underline', range.from, range.to)
    if (op.type === 'set_strikethrough') return applyMark(tr, schema, 'strike', range.from, range.to)
    if (op.type === 'set_highlight') return applyMark(tr, schema, 'highlight', range.from, range.to)
    if (op.type === 'set_link') return applyMark(tr, schema, 'link', range.from, range.to, { href: op.href })
    if (op.type === 'set_heading') {
      const heading = schema.nodes.heading
      if (!heading) return false
      tr.setBlockType(range.from, range.to, heading, { level: op.level })
      return true
    }
    if (op.type === 'set_align' || op.type === 'set_font_family' || op.type === 'set_font_size' || op.type === 'set_color') {
      return false
    }
  }
  return false
}

function applyPlanToTransaction(tr: Transaction, schema: Schema, plan: ResolvedPlan): boolean {
  try {
    for (const step of plan.steps) {
      if (!applyStepToTransaction(tr, schema, step)) return false
    }
    return true
  } catch {
    return false
  }
}

function applyResolvedPlan(editor: AtomicEditor, plan: ResolvedPlan): ExecuteResult {
  const chain = tipTapChain(editor)
  if (chain) {
    let failed = false
    const ran = chain.command(({ tr, commands }) => {
      closeHistory(tr)
      try {
        for (const step of plan.steps) {
          if (!applyStepWithCommands(tr, commands, step)) {
            tr.setMeta('preventDispatch', true)
            failed = true
            return false
          }
        }
        return true
      } catch {
        tr.setMeta('preventDispatch', true)
        failed = true
        return false
      }
    }).run()
    if (!ran || failed) return { ok: false, reason: 'atomic apply could not represent the batch' }
    return { ok: true, operations: plan.steps.map(step => step.op) }
  }

  const tr = closeHistory(editor.state.tr)
  if (!applyPlanToTransaction(tr, editor.schema, plan)) {
    return { ok: false, reason: 'atomic apply could not represent the batch' }
  }
  editor.view.dispatch(tr)
  return { ok: true, operations: plan.steps.map(step => step.op) }
}

export function applyOperationBatch(
  editor: AtomicEditor,
  ops: readonly AiOperation[],
  ctx: RequestContext,
): ExecuteResult {
  if (ops.length === 0) return { ok: true, operations: [] }
  const planned = planOperations(ops, ctx, ctx.documentNode)
  if (!planned.ok) return planned
  return applyResolvedPlan(editor, planned.plan)
}

export function executeAiOperations(
  editor: AtomicEditor,
  rawOperations: unknown,
  ctx: RequestContext,
): ExecuteResult {
  const decoded = decodeOperations(rawOperations)
  if (!decoded.ok) return decoded
  if (decoded.operations.length === 0) return { ok: true, operations: [] }
  if (!editor.state.doc.eq(ctx.documentNode)) {
    return { ok: false, reason: 'document drifted before apply' }
  }
  return applyOperationBatch(editor, decoded.operations, ctx)
}

export function reviewEventAfterExecute(
  result: ExecuteResult,
  confirmable: boolean,
): { type: 'applied'; operationsCount: number; confirmable: boolean } | null {
  if (!result.ok || result.operations.length === 0) return null
  return { type: 'applied', operationsCount: result.operations.length, confirmable }
}
