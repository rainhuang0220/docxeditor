import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { history, undo, redo } from '@tiptap/pm/history'
import {
  REVIEW_LOCK_META,
  allowReviewTransaction,
  authorizeRestoreTr,
  createReviewLockPlugin,
  restoreSnapshotTr,
} from './reviewLock.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    table: { group: 'block', content: 'table_row+' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph+' },
    text: { group: 'inline' },
  },
  marks: {
    bold: {},
  },
})

function paragraph(text: string): Node {
  return schema.node('paragraph', null, text ? [schema.text(text)] : [])
}

function tableDoc(): Node {
  const cell = schema.node('table_cell', null, [paragraph('c')])
  const row = schema.node('table_row', null, [cell])
  return schema.node('doc', null, [
    paragraph('Hello world'),
    schema.node('table', null, [row]),
  ])
}

function createEditor(pending: { value: boolean }) {
  return EditorState.create({
    schema,
    doc: tableDoc(),
    plugins: [history(), createReviewLockPlugin(() => pending.value)],
  })
}

function assertBlocked(before: EditorState, tr: Transaction) {
  const result = before.applyTransaction(tr)
  assert.equal(result.transactions.length, 0)
  assert.equal(result.state, before)
  assert.equal(result.state.doc.eq(before.doc), true)
}

function assertApplied(before: EditorState, tr: Transaction): EditorState {
  const result = before.applyTransaction(tr)
  assert.ok(result.transactions.length >= 1)
  assert.notEqual(result.state, before)
  return result.state
}

test('allowReviewTransaction: idle docChanged is allowed', () => {
  assert.equal(allowReviewTransaction({
    pending: false,
    docChanged: true,
    storedMarksSet: false,
    restoreAuthorized: false,
    restoreMeta: false,
  }), true)
  assert.equal(allowReviewTransaction({
    pending: true,
    docChanged: true,
    storedMarksSet: false,
    restoreAuthorized: true,
    restoreMeta: false,
  }), false)
})

test('review idle + normal docChanged transaction → allowed', () => {
  const pending = { value: false }
  const state = createEditor(pending)
  const next = assertApplied(state, state.tr.insertText('X', 1))
  assert.equal(next.doc.textContent.includes('X'), true)
})

test('review pending + ordinary text insertion → blocked', () => {
  const pending = { value: true }
  const state = createEditor(pending)
  assertBlocked(state, state.tr.insertText('Z', 1))
})

test('review pending + formatting transaction → blocked', () => {
  const pending = { value: true }
  const state = createEditor(pending)
  assertBlocked(state, state.tr.addMark(1, 6, schema.marks.bold.create()))
})

test('review pending + stored-marks-only transaction → blocked', () => {
  const pending = { value: true }
  const state = createEditor(pending)
  assertBlocked(state, state.tr.setStoredMarks([schema.marks.bold.create()]))
})

test('review pending + undo/redo-style docChanged transaction → blocked', () => {
  const pending = { value: false }
  let state = createEditor(pending)
  state = assertApplied(state, state.tr.insertText('U', 1))
  pending.value = true
  undo(state, tr => {
    assertBlocked(state, tr)
  })
  redo(state, tr => {
    assertBlocked(state, tr)
  })
})

test('review pending + table/document structural transaction → blocked', () => {
  const pending = { value: true }
  const state = createEditor(pending)
  assertBlocked(state, state.tr.setBlockType(1, 1, schema.nodes.heading, { level: 2 }))
  let tablePos = -1
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') {
      tablePos = pos
      return false
    }
    return true
  })
  assert.ok(tablePos >= 0)
  const row = schema.node('table_row', null, [
    schema.node('table_cell', null, [paragraph('n')]),
  ])
  assertBlocked(state, state.tr.insert(tablePos + 1, row))
})

test('review pending + selection-only transaction → allowed', () => {
  const pending = { value: true }
  const state = createEditor(pending)
  const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 6))
  assert.equal(tr.docChanged, false)
  const next = assertApplied(state, tr)
  assert.equal(next.doc.eq(state.doc), true)
  assert.equal(next.selection.from, 1)
  assert.equal(next.selection.to, 6)
})

test('review pending + cursor movement → allowed', () => {
  const pending = { value: true }
  const state = createEditor(pending)
  const tr = state.tr.setSelection(TextSelection.create(state.doc, 5))
  assert.equal(tr.docChanged, false)
  const next = assertApplied(state, tr)
  assert.equal(next.doc.eq(state.doc), true)
  assert.equal(next.selection.head, 5)
})

test('review pending + unauthorized programmatic dispatch → blocked', () => {
  const pending = { value: true }
  const state = createEditor(pending)
  const hack = state.tr.replaceWith(0, state.doc.content.size, paragraph('hack'))
  assertBlocked(state, hack)
  assertBlocked(state, restoreSnapshotTr(state, paragraph('hack')))
})

test('review pending + authorized Reject restore → allowed exactly once', () => {
  const pending = { value: false }
  let state = createEditor(pending)
  const snapshot = state.doc
  state = assertApplied(state, state.tr.insertText('AI', 1))
  pending.value = true
  state = assertApplied(state, authorizeRestoreTr(state))
  state = assertApplied(state, restoreSnapshotTr(state, snapshot))
  assert.equal(state.doc.eq(snapshot), true)
  assertBlocked(state, restoreSnapshotTr(state, snapshot))
})

test('after Reject → normal mutations work again', () => {
  const pending = { value: false }
  let state = createEditor(pending)
  const snapshot = state.doc
  state = assertApplied(state, state.tr.insertText('AI', 1))
  pending.value = true
  state = assertApplied(state, authorizeRestoreTr(state))
  state = assertApplied(state, restoreSnapshotTr(state, snapshot))
  pending.value = false
  state = assertApplied(state, state.tr.insertText('ok', 1))
  assert.equal(state.doc.textContent.includes('ok'), true)
})

test('after Accept → normal mutations work again', () => {
  const pending = { value: false }
  let state = createEditor(pending)
  state = assertApplied(state, state.tr.insertText('AI', 1))
  pending.value = true
  pending.value = false
  state = assertApplied(state, state.tr.insertText('ok', 1))
  assert.equal(state.doc.textContent.includes('AI'), true)
  assert.equal(state.doc.textContent.includes('ok'), true)
})

test('authorization/bypass cannot leak to the next transaction', () => {
  const pending = { value: false }
  let state = createEditor(pending)
  const snapshot = state.doc
  state = assertApplied(state, state.tr.insertText('AI', 1))
  pending.value = true
  state = assertApplied(state, authorizeRestoreTr(state))
  state = assertApplied(state, restoreSnapshotTr(state, snapshot))
  const leak = state.tr.insertText('nope', 1).setMeta(REVIEW_LOCK_META, {
    restore: true,
    authorizeRestore: true,
  })
  assertBlocked(state, leak)
})

test('stale/double Reject cannot use the authorization twice', () => {
  const pending = { value: false }
  let state = createEditor(pending)
  const snapshot = state.doc
  state = assertApplied(state, state.tr.insertText('AI', 1))
  pending.value = true
  state = assertApplied(state, authorizeRestoreTr(state))
  state = assertApplied(state, authorizeRestoreTr(state))
  state = assertApplied(state, restoreSnapshotTr(state, snapshot))
  assertBlocked(state, restoreSnapshotTr(state, snapshot))
})

test('authorizeRestore does not open a general mutation bypass', () => {
  const pending = { value: true }
  let state = createEditor(pending)
  state = assertApplied(state, authorizeRestoreTr(state))
  assertBlocked(state, state.tr.insertText('nope', 1))
})
