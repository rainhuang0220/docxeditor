import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeHistory, undo, undoDepth } from '@tiptap/pm/history'
import { Editor } from '@tiptap/core'
import { captureRequestContext } from './requestContext.ts'
import { executeAiOperations, planOperations, reviewEventAfterExecute } from './applyOperations.ts'
import { getDocumentRevision } from './documentRevision.ts'
import { authorizeRestoreTr } from './reviewLock.ts'
import { checkpointHistory, rejectRestoreTr } from './reviewHistory.ts'
import { PRODUCTION_PATH_FIXTURES } from './operationFixtures.ts'
import type { AiOperation } from './operations.ts'
import {
  blockTexts,
  createHeadlessEditor,
  paragraphsHtml,
} from '../test/headlessEditor.ts'

function userEdit(editor: Editor, html: string) {
  editor.chain().command(({ tr, commands }) => {
    closeHistory(tr)
    return commands.setContent(html)
  }).run()
}

function capture(editor: Editor, html: string) {
  return captureRequestContext({
    requestId: 'req-1',
    source: 'panel',
    state: editor.state,
    html,
    threadId: 't1',
    modelId: 'm1',
  })
}

test('real TipTap Editor boots with shared production core extensions', () => {
  const h = createHeadlessEditor({ html: '<p>Hello</p>' })
  try {
    const { nodes, marks } = h.editor.schema
    assert.ok(nodes.heading)
    assert.ok(nodes.table)
    assert.ok(nodes.image)
    assert.ok(nodes.horizontalRule)
    assert.ok(nodes.blockquote)
    assert.ok(nodes.codeBlock)
    assert.ok(nodes.bulletList)
    assert.ok(nodes.pageBreak)
    assert.ok(marks.bold)
    assert.ok(marks.italic)
    assert.ok(marks.underline)
    assert.ok(marks.strike)
    assert.ok(marks.highlight)
    assert.ok(marks.link)
    assert.ok(marks.textStyle)
    assert.equal(typeof h.editor.chain, 'function')
    assert.equal(typeof h.editor.commands.insertTable, 'function')
    assert.equal(typeof h.editor.commands.setFontSize, 'function')
    assert.equal(typeof h.editor.commands.setImage, 'function')
  } finally {
    h.destroy()
  }
})

test('every AiOperation type has an exhaustive production-path fixture', () => {
  const types = Object.keys(PRODUCTION_PATH_FIXTURES) as AiOperation['type'][]
  assert.equal(types.length, 24)
  for (const type of types) {
    assert.equal(PRODUCTION_PATH_FIXTURES[type].type, type)
  }
})

test('replace_content works through the real chain', () => {
  const html = '<p>Old</p>'
  const h = createHeadlessEditor({ html })
  try {
    const ctx = capture(h.editor, html)
    h.resetCounts()
    const result = executeAiOperations(h.editor, [PRODUCTION_PATH_FIXTURES.replace_content], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.equal(h.editor.getText().includes('ReplacedDoc'), true)
    assert.equal(h.docChangedDispatches, 1)
  } finally {
    h.destroy()
  }
})

test('indexed replace/delete/insert-after preserve original numbering', () => {
  const labels = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']
  const html = paragraphsHtml(labels)
  const h = createHeadlessEditor({ html })
  try {
    const ctx = capture(h.editor, html)
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

test('captured selection replacement uses the request-time range', () => {
  const html = '<p>Hello world</p>'
  const h = createHeadlessEditor({ html })
  try {
    h.editor.commands.setTextSelection({ from: 1, to: 6 })
    const ctx = capture(h.editor, html)
    h.editor.commands.setTextSelection({ from: 7, to: 12 })
    const result = executeAiOperations(h.editor, [{ type: 'replace_selection', content: 'XXXXX' }], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.equal(h.editor.state.doc.textBetween(1, 6), 'XXXXX')
    assert.equal(h.editor.state.doc.textBetween(7, 12), 'world')
  } finally {
    h.destroy()
  }
})

test('captured cursor insertion uses request-time position', () => {
  const html = '<p>Hello</p>'
  const h = createHeadlessEditor({ html })
  try {
    h.editor.commands.setTextSelection(1)
    const ctx = capture(h.editor, html)
    h.editor.commands.setTextSelection(h.editor.state.doc.content.size)
    const result = executeAiOperations(h.editor, [{ type: 'insert_at_cursor', content: '<p>Z</p>' }], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.equal(blockTexts(h.editor)[0], 'Z')
  } finally {
    h.destroy()
  }
})

test('multi-mark formatting composes on the captured selection', () => {
  const html = '<p>Hello world</p>'
  const h = createHeadlessEditor({ html })
  try {
    h.editor.commands.setTextSelection({ from: 1, to: 6 })
    const ctx = capture(h.editor, html)
    const result = executeAiOperations(h.editor, [{ type: 'set_bold' }, { type: 'set_italic' }], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    const marks = h.editor.state.doc.resolve(2).marks().map(m => m.type.name)
    assert.equal(marks.includes('bold'), true)
    assert.equal(marks.includes('italic'), true)
  } finally {
    h.destroy()
  }
})

test('heading alignment font and color commands use the production schema', () => {
  const html = '<p>Hello world</p>'
  const h = createHeadlessEditor({ html })
  try {
    h.editor.commands.setTextSelection({ from: 1, to: 6 })
    const ctx = capture(h.editor, html)
    const heading = executeAiOperations(h.editor, [{ type: 'set_heading', level: 2 }], ctx)
    assert.equal(heading.ok, true, heading.ok === false ? heading.reason : '')
    h.editor.commands.setTextSelection({ from: 1, to: 6 })
    const ctx2 = capture(h.editor, h.editor.getHTML())
    const rest = executeAiOperations(h.editor, [
      { type: 'set_align', alignment: 'center' },
      { type: 'set_font_family', family: 'Arial' },
      { type: 'set_font_size', size: '18pt' },
      { type: 'set_color', color: '#ff0000' },
    ], ctx2)
    assert.equal(rest.ok, true, rest.ok === false ? rest.reason : '')
    assert.equal(h.editor.state.doc.firstChild?.type.name, 'heading')
    assert.equal(h.editor.state.doc.firstChild?.attrs.level, 2)
    assert.equal(h.editor.state.doc.firstChild?.attrs.textAlign, 'center')
    const style = h.editor.getAttributes('textStyle')
    assert.equal(style.fontFamily, 'Arial')
    assert.equal(style.fontSize, '18pt')
    assert.equal(style.color, '#ff0000')
  } finally {
    h.destroy()
  }
})

test('table list image hr blockquote and code block insert on the real chain', () => {
  const html = '<p>Keep</p><p></p>'
  const h = createHeadlessEditor({ html })
  try {
    const end = h.editor.state.doc.content.size - 1
    h.editor.commands.setTextSelection(end)
    const ctx = capture(h.editor, html)
    const ops: AiOperation[] = [
      PRODUCTION_PATH_FIXTURES.insert_table,
      PRODUCTION_PATH_FIXTURES.insert_list,
      PRODUCTION_PATH_FIXTURES.insert_horizontal_rule,
      PRODUCTION_PATH_FIXTURES.insert_blockquote,
      PRODUCTION_PATH_FIXTURES.insert_code_block,
      PRODUCTION_PATH_FIXTURES.insert_image,
    ]
    const planned = planOperations(ops, ctx, ctx.documentNode)
    assert.equal(planned.ok, true)
    h.resetCounts()
    const result = executeAiOperations(h.editor, ops, ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    const json = JSON.stringify(h.editor.getJSON())
    assert.equal(json.includes('"type":"table"'), true)
    assert.equal(json.includes('"type":"orderedList"') || json.includes('"type":"bulletList"'), true)
    assert.equal(json.includes('"type":"horizontalRule"'), true)
    assert.equal(json.includes('"type":"blockquote"'), true)
    assert.equal(json.includes('"type":"codeBlock"'), true)
    assert.equal(json.includes('"type":"image"'), true)
    assert.equal(h.docChangedDispatches, 1)
  } finally {
    h.destroy()
  }
})

test('underline strikethrough highlight and link apply on the real chain', () => {
  const html = '<p>Hello world</p>'
  const h = createHeadlessEditor({ html })
  try {
    h.editor.commands.setTextSelection({ from: 1, to: 6 })
    const ctx = capture(h.editor, html)
    const result = executeAiOperations(h.editor, [
      { type: 'set_underline' },
      { type: 'set_strikethrough' },
      { type: 'set_highlight' },
      { type: 'set_link', href: 'https://example.com' },
    ], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    const marks = h.editor.state.doc.resolve(2).marks().map(m => m.type.name)
    assert.equal(marks.includes('underline'), true)
    assert.equal(marks.includes('strike'), true)
    assert.equal(marks.includes('highlight'), true)
    assert.equal(marks.includes('link'), true)
  } finally {
    h.destroy()
  }
})

test('insert_at_end appends through the real chain', () => {
  const html = '<p>A</p>'
  const h = createHeadlessEditor({ html })
  try {
    const ctx = capture(h.editor, html)
    const result = executeAiOperations(h.editor, [{ type: 'insert_at_end', content: '<p>B</p>' }], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.deepEqual(blockTexts(h.editor).slice(0, 2), ['A', 'B'])
  } finally {
    h.destroy()
  }
})

test('valid multi-op result produces one document-changing apply and one revision', () => {
  const html = paragraphsHtml(['A', 'B', 'C'])
  const h = createHeadlessEditor({ html })
  try {
    const ctx = capture(h.editor, html)
    const rev = getDocumentRevision(h.editor.state)
    h.resetCounts()
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 0, content: '<p>X</p>' },
      { type: 'delete_paragraph', paragraph_index: 2 },
    ], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.deepEqual(blockTexts(h.editor), ['X', 'B'])
    assert.equal(h.docChangedDispatches, 1)
    assert.equal(h.appliedDocChanged, 1)
    assert.equal(getDocumentRevision(h.editor.state), rev + 1)
  } finally {
    h.destroy()
  }
})

test('accepted multi-op batch is one logical Undo', () => {
  const h = createHeadlessEditor({ html: '<p>A0</p>' })
  try {
    userEdit(h.editor, '<p>A1</p>')
    userEdit(h.editor, '<p>A2</p>')
    const depth = undoDepth(h.editor.state)
    const ctx = capture(h.editor, '<p>A2</p>')
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 0, content: '<p>B1</p>' },
      { type: 'insert_after_paragraph', paragraph_index: 0, content: '<p>B2</p>' },
    ], ctx)
    assert.equal(result.ok, true, result.ok === false ? result.reason : '')
    assert.equal(undoDepth(h.editor.state), depth + 1)
    assert.deepEqual(blockTexts(h.editor), ['B1', 'B2'])
    undo(h.editor.state, tr => { h.editor.view.dispatch(tr) })
    assert.equal(h.editor.getText().replace(/\n/g, ''), 'A2')
    h.editor.commands.redo()
    assert.equal(blockTexts(h.editor)[0], 'B1')
  } finally {
    h.destroy()
  }
})

test('apply-stage operation N failure dispatches zero canonical mutation', () => {
  const html = paragraphsHtml(['Keep', 'Change'])
  const h = createHeadlessEditor({ html, without: ['table'] })
  try {
    h.editor.commands.setTextSelection(1)
    const ctx = capture(h.editor, html)
    const planned = planOperations([
      { type: 'replace_paragraph', paragraph_index: 1, content: '<p>X</p>' },
      { type: 'insert_table', rows: 2, cols: 2 },
    ], ctx, ctx.documentNode)
    assert.equal(planned.ok, true, 'preflight must succeed so the chain runs')
    const before = h.editor.state.doc.toJSON()
    const rev = getDocumentRevision(h.editor.state)
    const depth = undoDepth(h.editor.state)
    h.resetCounts()
    const result = executeAiOperations(h.editor, [
      { type: 'replace_paragraph', paragraph_index: 1, content: '<p>X</p>' },
      { type: 'insert_table', rows: 2, cols: 2 },
    ], ctx)
    assert.equal(result.ok, false)
    assert.deepEqual(h.editor.state.doc.toJSON(), before)
    assert.equal(h.docChangedDispatches, 0)
    assert.equal(h.attemptedDispatches, 0)
    assert.equal(getDocumentRevision(h.editor.state), rev)
    assert.equal(undoDepth(h.editor.state), depth)
    assert.equal(reviewEventAfterExecute(result, true), null)
  } finally {
    h.destroy()
  }
})

test('ReviewLock blocks docChanged while pending and allows selection', () => {
  let pending = false
  const html = '<p>A</p>'
  const h = createHeadlessEditor({ html, isLocked: () => pending })
  try {
    const ctx = capture(h.editor, html)
    assert.equal(executeAiOperations(h.editor, [{ type: 'replace_paragraph', paragraph_index: 0, content: '<p>B</p>' }], ctx).ok, true)
    pending = true
    const before = h.editor.state.doc.textContent
    h.editor.commands.insertContent('X')
    assert.equal(h.editor.state.doc.textContent, before)
    const from = h.editor.state.selection.from
    h.editor.commands.setTextSelection(1)
    assert.equal(h.editor.state.selection.from, 1)
    assert.notEqual(from, undefined)
  } finally {
    h.destroy()
  }
})

test('Reject cannot resurrect the proposal through Undo', () => {
  const h = createHeadlessEditor({ html: '<p>A0</p>' })
  try {
    userEdit(h.editor, '<p>A1</p>')
    userEdit(h.editor, '<p>A2</p>')
    const a2 = h.editor.state.doc
    const hist = checkpointHistory(h.editor.state)
    const ctx = capture(h.editor, '<p>A2</p>')
    assert.equal(executeAiOperations(h.editor, [{ type: 'replace_paragraph', paragraph_index: 0, content: '<p>B</p>' }], ctx).ok, true)
    h.editor.view.dispatch(authorizeRestoreTr(h.editor.state))
    h.editor.view.dispatch(rejectRestoreTr(h.editor.state, a2, hist))
    assert.equal(h.editor.getText().replace(/\n/g, ''), 'A2')
    undo(h.editor.state, tr => { h.editor.view.dispatch(tr) })
    assert.equal(h.editor.getText().replace(/\n/g, ''), 'A1')
    assert.notEqual(h.editor.getText().includes('B'), true)
  } finally {
    h.destroy()
  }
})

test('missing chain fails closed with zero mutation', () => {
  const html = '<p>A</p>'
  const h = createHeadlessEditor({ html })
  try {
    const ctx = capture(h.editor, html)
    const before = h.editor.state.doc.toJSON()
    const editor = h.editor as unknown as { chain?: unknown }
    const saved = editor.chain
    editor.chain = undefined
    const result = executeAiOperations(h.editor, [{ type: 'replace_paragraph', paragraph_index: 0, content: '<p>X</p>' }], ctx)
    editor.chain = saved
    assert.equal(result.ok, false)
    assert.deepEqual(h.editor.state.doc.toJSON(), before)
  } finally {
    h.destroy()
  }
})
