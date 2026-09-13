import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { createDocumentRevisionPlugin, getDocumentRevision } from './documentRevision.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    text: { group: 'inline' },
  },
  marks: { bold: {} },
})

function createState() {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Hello world')]),
  ])
  return EditorState.create({
    schema,
    doc,
    plugins: [createDocumentRevisionPlugin()],
  })
}

test('selection movement does not increment document revision', () => {
  const state = createState()
  const n = getDocumentRevision(state)
  const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)))
  assert.equal(next.tr.docChanged, false)
  assert.equal(getDocumentRevision(next), n)
})

test('cursor movement does not increment document revision', () => {
  const state = createState()
  const n = getDocumentRevision(state)
  const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5)))
  assert.equal(getDocumentRevision(next), n)
})

test('text insertion increments revision', () => {
  const state = createState()
  const n = getDocumentRevision(state)
  const next = state.apply(state.tr.insertText('X', 1))
  assert.equal(getDocumentRevision(next), n + 1)
})

test('formatting that changes the document increments revision', () => {
  const state = createState()
  const n = getDocumentRevision(state)
  const next = state.apply(state.tr.addMark(1, 6, schema.marks.bold.create()))
  assert.equal(getDocumentRevision(next), n + 1)
})

test('structural edit increments revision', () => {
  const state = createState()
  const n = getDocumentRevision(state)
  const next = state.apply(state.tr.setBlockType(1, 1, schema.nodes.heading, { level: 2 }))
  assert.equal(getDocumentRevision(next), n + 1)
})
