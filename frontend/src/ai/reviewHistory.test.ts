import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { history, closeHistory, undo, redo, undoDepth } from '@tiptap/pm/history'
import {
  authorizeRestoreTr,
  createReviewLockPlugin,
} from './reviewLock.ts'
import {
  checkpointHistory,
  rejectRestoreTr,
  stampAppendedTransaction,
} from './reviewHistory.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
})

function docOf(text: string): Node {
  return schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ])
}

function createState() {
  return EditorState.create({
    schema,
    doc: docOf('A0'),
    plugins: [history(), createReviewLockPlugin(() => false)],
  })
}

function setDoc(state: EditorState, text: string) {
  return state.apply(closeHistory(state.tr.replaceWith(0, state.doc.content.size, docOf(text).content)))
}

function undoOnce(state: EditorState): EditorState {
  let next = state
  undo(state, tr => { next = state.apply(tr) })
  return next
}

function redoOnce(state: EditorState): EditorState {
  let next = state
  redo(state, tr => { next = state.apply(tr) })
  return next
}

function applyProposal(state: EditorState, text: string, first?: Transaction) {
  let tr = state.tr.replaceWith(0, state.doc.content.size, docOf(text).content)
  if (first) tr = stampAppendedTransaction(tr, first)
  else tr = closeHistory(tr)
  return { state: state.apply(tr), tr }
}

test('idle user history still works normally', () => {
  let state = createState()
  state = setDoc(state, 'A1')
  state = setDoc(state, 'A2')
  assert.equal(state.doc.textContent, 'A2')
  state = undoOnce(state)
  assert.equal(state.doc.textContent, 'A1')
  state = undoOnce(state)
  assert.equal(state.doc.textContent, 'A0')
  state = redoOnce(state)
  assert.equal(state.doc.textContent, 'A1')
})

test('A0→A1→A2 → AI B → Reject → Undo is A1, Redo is A2, never B', () => {
  let state = createState()
  state = setDoc(state, 'A1')
  state = setDoc(state, 'A2')
  const a2 = state.doc
  const hist = checkpointHistory(state)
  assert.ok(hist)
  const depthAtA2 = undoDepth(state)

  const applied = applyProposal(state, 'B')
  state = applied.state
  assert.equal(state.doc.textContent, 'B')
  assert.equal(undoDepth(state), depthAtA2 + 1)

  state = state.apply(authorizeRestoreTr(state))
  state = state.apply(rejectRestoreTr(state, a2, hist))
  assert.equal(state.doc.textContent, 'A2')
  assert.equal(undoDepth(state), depthAtA2)

  state = undoOnce(state)
  assert.equal(state.doc.textContent, 'A1')
  assert.notEqual(state.doc.textContent, 'B')

  state = redoOnce(state)
  assert.equal(state.doc.textContent, 'A2')
  assert.notEqual(state.doc.textContent, 'B')
})

test('A0→A1→A2 → AI B → Accept → Undo is A2, Redo is B, earlier history kept', () => {
  let state = createState()
  state = setDoc(state, 'A1')
  state = setDoc(state, 'A2')
  const depthAtA2 = undoDepth(state)

  const applied = applyProposal(state, 'B')
  state = applied.state
  assert.equal(state.doc.textContent, 'B')
  assert.equal(undoDepth(state), depthAtA2 + 1)

  state = undoOnce(state)
  assert.equal(state.doc.textContent, 'A2')
  state = undoOnce(state)
  assert.equal(state.doc.textContent, 'A1')
  state = redoOnce(state)
  assert.equal(state.doc.textContent, 'A2')
  state = redoOnce(state)
  assert.equal(state.doc.textContent, 'B')
})

test('grouped AI batch is one undo step after Accept', () => {
  let state = createState()
  state = setDoc(state, 'A2')
  const depth = undoDepth(state)
  const first = applyProposal(state, 'B1')
  state = first.state
  const second = applyProposal(state, 'B2', first.tr)
  state = second.state
  assert.equal(state.doc.textContent, 'B2')
  assert.equal(undoDepth(state), depth + 1)
  state = undoOnce(state)
  assert.equal(state.doc.textContent, 'A2')
})

test('repeated Reject restore does not resurrect B', () => {
  let state = createState()
  state = setDoc(state, 'A2')
  const a2 = state.doc
  const hist = checkpointHistory(state)!
  state = applyProposal(state, 'B').state
  state = state.apply(authorizeRestoreTr(state))
  state = state.apply(rejectRestoreTr(state, a2, hist))
  state = state.apply(authorizeRestoreTr(state))
  state = state.apply(rejectRestoreTr(state, a2, hist))
  assert.equal(state.doc.textContent, 'A2')
  state = undoOnce(state)
  assert.notEqual(state.doc.textContent, 'B')
})
