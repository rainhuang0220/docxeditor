import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { history, closeHistory, undo, undoDepth } from '@tiptap/pm/history'
import { createDocumentRevisionPlugin, getDocumentRevision } from './documentRevision.ts'
import {
  authorizeRestoreTr,
  createReviewLockPlugin,
} from './reviewLock.ts'
import {
  checkpointHistory,
  rejectRestoreTr,
} from './reviewHistory.ts'
import { captureRequestContext, type RequestContext } from './requestContext.ts'
import { decodeOperations } from './operations.ts'
import { executeAiOperations, planOperations, reviewEventAfterExecute } from './applyOperations.ts'
import { blockTexts, createHeadlessEditor, paragraphsHtml } from '../test/headlessEditor.ts'
import { reduceReview, initialReviewState } from './reviewTransaction.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    text: { group: 'inline' },
  },
  marks: {
    bold: {},
    italic: {},
  },
})

function para(text: string): Node {
  return schema.node('paragraph', null, text ? [schema.text(text)] : [])
}

function docOf(texts: string[]): Node {
  return schema.node('doc', null, texts.map(para))
}

interface TestEditor {
  schema: Schema
  state: EditorState
  view: { dispatch: (tr: Transaction) => void; state: EditorState }
  dispatchCount: number
}

function createEditor(texts: string[], opts?: { history?: boolean; lock?: () => boolean }): TestEditor {
  const plugins = [createDocumentRevisionPlugin()]
  if (opts?.history !== false) plugins.push(history())
  if (opts?.lock) plugins.push(createReviewLockPlugin(opts.lock))
  let state = EditorState.create({ schema, doc: docOf(texts), plugins })
  const editor: TestEditor = {
    schema,
    get state() { return state },
    dispatchCount: 0,
    view: {
      get state() { return state },
      dispatch(tr: Transaction) {
        for (const plugin of state.plugins) {
          const filter = plugin.spec.filterTransaction
          if (filter && !filter.call(plugin, tr, state)) return
        }
        editor.dispatchCount += 1
        state = state.apply(tr)
      },
    },
  }
  return editor
}

function capture(editor: TestEditor): RequestContext {
  const ctx = captureRequestContext({
    requestId: 'req-1',
    source: 'panel',
    state: editor.state,
    html: editor.state.doc.textContent,
    threadId: 't1',
    modelId: 'm1',
  })
  editor.dispatchCount = 0
  return ctx
}

function typed(raw: unknown) {
  const decoded = decodeOperations(raw)
  assert.equal(decoded.ok, true, decoded.ok === false ? decoded.reason : '')
  if (!decoded.ok) throw new Error('decode failed')
  return decoded.operations
}

function textsOf(doc: Node): string[] {
  const out: string[] = []
  doc.forEach(node => { out.push(node.textContent) })
  return out
}

test('case 9: paragraph index 0 valid when block exists', () => {
  const editor = createEditor(['A', 'B'])
  const ctx = capture(editor)
  const planned = planOperations(typed([{ type: 'replace_paragraph', paragraph_index: 0, content: '<p>Z</p>' }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, true)
})

test('case 10: last valid index works', () => {
  const editor = createEditor(['A', 'B', 'C'])
  const ctx = capture(editor)
  const planned = planOperations(typed([{ type: 'delete_paragraph', paragraph_index: 2 }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, true)
})

test('case 11: paragraph index -1 rejected', () => {
  assert.equal(decodeOperations([{ type: 'delete_paragraph', paragraph_index: -1 }]).ok, false)
})

test('case 12: index equal to block count rejected', () => {
  const editor = createEditor(['A', 'B'])
  const ctx = capture(editor)
  const planned = planOperations(typed([{ type: 'replace_paragraph', paragraph_index: 2, content: '<p>Z</p>' }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, false)
})

test('case 13: huge OOB rejected', () => {
  const editor = createEditor(['A'])
  const ctx = capture(editor)
  const planned = planOperations(typed([{ type: 'delete_paragraph', paragraph_index: 9999 }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, false)
})

test('case 15: OOB replace never appends', () => {
  const editor = createEditor(['Keep'])
  const ctx = capture(editor)
  const before = editor.state.doc.toJSON()
  const result = executeAiOperations(editor, [{ type: 'replace_paragraph', paragraph_index: 4, content: '<p>APPENDED</p>' }], ctx)
  assert.equal(result.ok, false)
  assert.equal(editor.dispatchCount, 0)
  assert.deepEqual(editor.state.doc.toJSON(), before)
  assert.equal(editor.state.doc.textContent.includes('APPENDED'), false)
})

test('case 16: OOB delete never becomes silent success', () => {
  const editor = createEditor(['Keep'])
  const ctx = capture(editor)
  const result = executeAiOperations(editor, [{ type: 'delete_paragraph', paragraph_index: 1 }], ctx)
  assert.equal(result.ok, false)
  assert.equal(editor.state.doc.textContent, 'Keep')
  assert.equal(editor.dispatchCount, 0)
})

test('case 17: OOB insert-after never becomes document-end insert', () => {
  const editor = createEditor(['Keep'])
  const ctx = capture(editor)
  const result = executeAiOperations(editor, [{ type: 'insert_after_paragraph', paragraph_index: 3, content: '<p>TAIL</p>' }], ctx)
  assert.equal(result.ok, false)
  assert.equal(editor.state.doc.textContent.includes('TAIL'), false)
  assert.equal(editor.dispatchCount, 0)
})

test('insert_after last original block is valid, not an OOB fallback', () => {
  const editor = createEditor(['A', 'B'])
  const ctx = capture(editor)
  const planned = planOperations(typed([{ type: 'insert_after_paragraph', paragraph_index: 1, content: '<p>C</p>' }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, true)
})

test('case 18: selection-target operation with missing/invalid range rejected in preflight', () => {
  const editor = createEditor(['Hello world'])
  const ctx = capture(editor)
  ctx.anchor = { from: 3, to: 3, cursor: 3, selectedText: '' }
  const planned = planOperations(typed([{ type: 'replace_selection', content: 'x' }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, false)
})

test('case 19: cursor-target operation with missing/invalid cursor rejected', () => {
  const editor = createEditor(['Hello world'])
  const ctx = capture(editor)
  ctx.anchor = { from: -1, to: -1, cursor: -1, selectedText: '' }
  const planned = planOperations(typed([{ type: 'insert_at_cursor', content: '<p>Z</p>' }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, false)
})

test('case 20: valid captured selection resolves', () => {
  const editor = createEditor(['Hello world'])
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 6)))
  const ctx = captureRequestContext({
    requestId: 'req-1', source: 'selection', state: editor.state, html: 'Hello world', threadId: 't1', modelId: 'm1',
  })
  const planned = planOperations(typed([{ type: 'replace_selection', content: 'XXXXX' }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, true)
  if (!planned.ok) return
  const step = planned.plan.steps[0]
  assert.equal(step.target.class, 'selection')
  if (step.target.class === 'selection') {
    assert.equal(step.target.from, 1)
    assert.equal(step.target.to, 6)
  }
})

test('case 21: valid captured cursor resolves', () => {
  const editor = createEditor(['Hello world'])
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
  const ctx = captureRequestContext({
    requestId: 'req-1', source: 'panel', state: editor.state, html: 'Hello world', threadId: 't1', modelId: 'm1',
  })
  const planned = planOperations(typed([{ type: 'insert_at_cursor', content: '<p>Z</p>' }]), ctx, ctx.documentNode)
  assert.equal(planned.ok, true)
  if (!planned.ok) return
  const step = planned.plan.steps[0]
  assert.equal(step.target.class, 'cursor')
  if (step.target.class === 'cursor') assert.equal(step.target.pos, 1)
})

test('case 22/23: valid op 1 + invalid op 2 rejects entire plan with zero mutation', () => {
  const editor = createEditor(['A', 'B', 'C'])
  const ctx = capture(editor)
  const before = editor.state.doc.toJSON()
  const rev = getDocumentRevision(editor.state)
  const result = executeAiOperations(editor, [
    { type: 'replace_paragraph', paragraph_index: 0, content: '<p>X</p>' },
    { type: 'delete_paragraph', paragraph_index: 9 },
  ], ctx)
  assert.equal(result.ok, false)
  assert.deepEqual(editor.state.doc.toJSON(), before)
  assert.equal(getDocumentRevision(editor.state), rev)
  assert.equal(editor.dispatchCount, 0)
})

test('case 24: replace_content mixed with target-dependent edit is rejected', () => {
  const editor = createEditor(['A', 'B'])
  const ctx = capture(editor)
  const result = executeAiOperations(editor, [
    { type: 'replace_content', content: '<p>ALL</p>' },
    { type: 'replace_paragraph', paragraph_index: 0, content: '<p>X</p>' },
  ], ctx)
  assert.equal(result.ok, false)
  assert.equal(editor.state.doc.textContent, 'AB')
})

test('case 25: conflicting destructive edits to same original block rejected', () => {
  const editor = createEditor(['A', 'B', 'C'])
  const ctx = capture(editor)
  const result = executeAiOperations(editor, [
    { type: 'replace_paragraph', paragraph_index: 1, content: '<p>X</p>' },
    { type: 'delete_paragraph', paragraph_index: 1 },
  ], ctx)
  assert.equal(result.ok, false)
  assert.deepEqual(textsOf(editor.state.doc), ['A', 'B', 'C'])
})

test('case 26: safe multiple formatting ops accepted', () => {
  const html = '<p>Hello world</p>'
  const h = createHeadlessEditor({ html })
  try {
    h.editor.commands.setTextSelection({ from: 1, to: 6 })
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'selection', state: h.editor.state, html, threadId: 't1', modelId: 'm1',
    })
    const planned = planOperations(typed([{ type: 'set_bold' }, { type: 'set_italic' }]), ctx, ctx.documentNode)
    assert.equal(planned.ok, true)
    const result = executeAiOperations(h.editor, [{ type: 'set_bold' }, { type: 'set_italic' }], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    const $pos = h.editor.state.doc.resolve(2)
    assert.equal($pos.marks().some(m => m.type.name === 'bold'), true)
    assert.equal($pos.marks().some(m => m.type.name === 'italic'), true)
  } finally {
    h.destroy()
  }
})

test('case 27: distinct indexed edits resolve against ORIGINAL block numbering', () => {
  const labels = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']
  const html = paragraphsHtml(labels)
  const h = createHeadlessEditor({ html })
  try {
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html, threadId: 't1', modelId: 'm1',
    })
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 2, content: '<p>R2</p>' },
      { type: 'delete_paragraph', paragraph_index: 8 },
      { type: 'insert_after_paragraph', paragraph_index: 10, content: '<p>NEW</p>' },
    ], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.deepEqual(blockTexts(h.editor), ['P0', 'P1', 'R2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P9', 'P10', 'NEW'])
  } finally {
    h.destroy()
  }
})

test('case 28: two valid operations commit together', () => {
  const html = paragraphsHtml(['A', 'B', 'C'])
  const h = createHeadlessEditor({ html })
  try {
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html, threadId: 't1', modelId: 'm1',
    })
    const rev = getDocumentRevision(h.editor.state)
    h.resetCounts()
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 0, content: '<p>X</p>' },
      { type: 'delete_paragraph', paragraph_index: 2 },
    ], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.deepEqual(blockTexts(h.editor), ['X', 'B'])
    assert.equal(h.docChangedDispatches, 1)
    assert.equal(getDocumentRevision(h.editor.state), rev + 1)
  } finally {
    h.destroy()
  }
})

test('case 29: three valid operations commit together', () => {
  const html = paragraphsHtml(['A', 'B', 'C', 'D'])
  const h = createHeadlessEditor({ html })
  try {
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html, threadId: 't1', modelId: 'm1',
    })
    h.resetCounts()
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 0, content: '<p>X</p>' },
      { type: 'delete_paragraph', paragraph_index: 2 },
      { type: 'insert_after_paragraph', paragraph_index: 3, content: '<p>Z</p>' },
    ], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.deepEqual(blockTexts(h.editor), ['X', 'B', 'D', 'Z'])
    assert.equal(h.docChangedDispatches, 1)
  } finally {
    h.destroy()
  }
})

test('case 30: fail construction of operation N leaves zero canonical mutation', () => {
  const html = paragraphsHtml(['Keep', 'Change'])
  const h = createHeadlessEditor({ html, without: ['table'] })
  try {
    h.editor.commands.setTextSelection(1)
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html, threadId: 't1', modelId: 'm1',
    })
    const before = h.editor.state.doc.toJSON()
    const rev = getDocumentRevision(h.editor.state)
    h.resetCounts()
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 1, content: '<p>X</p>' },
      { type: 'insert_table', rows: 2, cols: 2 },
    ], ctx)
    assert.equal(result.ok, false)
    assert.deepEqual(h.editor.state.doc.toJSON(), before)
    assert.equal(getDocumentRevision(h.editor.state), rev)
    assert.equal(h.docChangedDispatches, 0)
  } finally {
    h.destroy()
  }
})

test('case 31/32/33: failed batch creates no review, history event, or revision', () => {
  const editor = createEditor(['A', 'B'])
  const ctx = capture(editor)
  const depth = undoDepth(editor.state)
  const rev = getDocumentRevision(editor.state)
  const result = executeAiOperations(editor, [
    { type: 'replace_paragraph', paragraph_index: 0, content: '<p>X</p>' },
    { type: 'magic_rewrite', content: 'nope' },
  ], ctx)
  assert.equal(result.ok, false)
  assert.equal(undoDepth(editor.state), depth)
  assert.equal(getDocumentRevision(editor.state), rev)
  assert.equal(reviewEventAfterExecute(result, true), null)
  const review = reduceReview(initialReviewState(), { type: 'applied', operationsCount: 0, confirmable: true })
  assert.equal(review.state.phase, 'idle')
  assert.equal(review.effects.includes('enterPending'), false)
})

test('case 34: successful atomic batch is one coherent AI history event', () => {
  const h = createHeadlessEditor({ html: '<p>A0</p>' })
  try {
    h.editor.chain().command(({ tr, commands }) => { closeHistory(tr); return commands.setContent('<p>A1</p>') }).run()
    h.editor.chain().command(({ tr, commands }) => { closeHistory(tr); return commands.setContent('<p>A2</p>') }).run()
    const depth = undoDepth(h.editor.state)
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html: '<p>A2</p>', threadId: 't1', modelId: 'm1',
    })
    h.resetCounts()
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 0, content: '<p>B1</p>' },
      { type: 'insert_after_paragraph', paragraph_index: 0, content: '<p>B2</p>' },
    ], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.equal(h.docChangedDispatches, 1)
    assert.equal(undoDepth(h.editor.state), depth + 1)
    assert.deepEqual(blockTexts(h.editor), ['B1', 'B2'])
  } finally {
    h.destroy()
  }
})

test('case 35: Accept Undo after atomic batch returns to pre-AI document', () => {
  const h = createHeadlessEditor({ html: '<p>A0</p>' })
  try {
    h.editor.chain().command(({ tr, commands }) => { closeHistory(tr); return commands.setContent('<p>A1</p>') }).run()
    h.editor.chain().command(({ tr, commands }) => { closeHistory(tr); return commands.setContent('<p>A2</p>') }).run()
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html: '<p>A2</p>', threadId: 't1', modelId: 'm1',
    })
    const applied = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 0, content: '<p>B</p>' },
    ], ctx)
    assert.equal(applied.ok, true, applied.ok === false ? applied.reason : '')
    undo(h.editor.state, tr => { h.editor.view.dispatch(tr) })
    assert.equal(h.editor.getText().replace(/\n/g, ''), 'A2')
  } finally {
    h.destroy()
  }
})

test('case 36: Reject history semantics restore pre-AI and cannot return B', () => {
  const h = createHeadlessEditor({ html: '<p>A0</p>' })
  try {
    h.editor.chain().command(({ tr, commands }) => { closeHistory(tr); return commands.setContent('<p>A1</p>') }).run()
    h.editor.chain().command(({ tr, commands }) => { closeHistory(tr); return commands.setContent('<p>A2</p>') }).run()
    const a2 = h.editor.state.doc
    const hist = checkpointHistory(h.editor.state)
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html: '<p>A2</p>', threadId: 't1', modelId: 'm1',
    })
    assert.equal(executeAiOperations(h.editor, [{ type: 'replace_paragraph', paragraph_index: 0, content: '<p>B</p>' }], ctx).ok, true)
    h.editor.view.dispatch(authorizeRestoreTr(h.editor.state))
    h.editor.view.dispatch(rejectRestoreTr(h.editor.state, a2, hist))
    assert.equal(h.editor.getText().replace(/\n/g, ''), 'A2')
    undo(h.editor.state, tr => { h.editor.view.dispatch(tr) })
    assert.equal(h.editor.getText().replace(/\n/g, ''), 'A1')
    assert.equal(h.editor.getText().includes('B'), false)
  } finally {
    h.destroy()
  }
})

test('case 37: successful atomic batch does not violate ReviewLock', () => {
  let pending = false
  const html = '<p>A</p>'
  const h = createHeadlessEditor({ html, isLocked: () => pending })
  try {
    const ctx = captureRequestContext({
      requestId: 'req-1', source: 'panel', state: h.editor.state, html, threadId: 't1', modelId: 'm1',
    })
    assert.equal(executeAiOperations(h.editor, [{ type: 'replace_paragraph', paragraph_index: 0, content: '<p>B</p>' }], ctx).ok, true)
    pending = true
    const before = h.editor.state.doc.textContent
    h.editor.commands.insertContent('X')
    assert.equal(h.editor.state.doc.textContent, before)
  } finally {
    h.destroy()
  }
})
