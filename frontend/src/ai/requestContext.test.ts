import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { createDocumentRevisionPlugin, getDocumentRevision } from './documentRevision.ts'
import { captureAnchor, captureRequestContext, isMutatingResultStale, requireOwningThreadId } from './requestContext.ts'
import { resolveOpTarget } from './operationTarget.ts'
import { planOperations } from './applyOperations.ts'
import { resetRequestLatch, tryBeginRequest, finishRequest, getInFlightRequestId, isRequestInFlight } from './requestLatch.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
})

function createState(text = 'Hello world') {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(text)]),
  ])
  return EditorState.create({
    schema,
    doc,
    plugins: [createDocumentRevisionPlugin()],
  })
}

function capture(state: EditorState) {
  return captureRequestContext({
    requestId: 'req-1',
    source: 'panel',
    state,
    html: '<p>Hello world</p>',
    threadId: 't1',
    modelId: 'm1',
  })
}

test('capture selection {from,to} at request time', () => {
  let state = createState()
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)))
  const anchor = captureAnchor(state)
  assert.equal(anchor.from, 1)
  assert.equal(anchor.to, 6)
  assert.equal(anchor.selectedText, 'Hello')
})

test('user moves selection elsewhere; replace_selection still uses captured range', () => {
  let state = createState()
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)))
  const ctx = capture(state)
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7, 12)))
  assert.equal(getDocumentRevision(state), ctx.documentRevision)
  const target = resolveOpTarget('replace_selection', ctx.anchor, state.doc.content.size)
  assert.equal(target.ok, true)
  if (!target.ok) return
  const next = state.apply(state.tr.insertText('XXXXX', target.from!, target.to!))
  assert.equal(next.doc.textBetween(1, 6, ' '), 'XXXXX')
  assert.equal(next.doc.textBetween(7, 12, ' '), 'world')
})

test('user moves cursor; insert_at_cursor still uses captured position', () => {
  let state = createState()
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)))
  const ctx = capture(state)
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 12)))
  const target = resolveOpTarget('insert_at_cursor', ctx.anchor, state.doc.content.size)
  assert.equal(target.ok, true)
  if (!target.ok) return
  const next = state.apply(state.tr.insertText('Z', target.pos!))
  assert.equal(next.doc.textContent.startsWith('ZHello'), true)
})

test('request-time selection formatting uses captured range not current selection', () => {
  let state = createState()
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)))
  const ctx = capture(state)
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7, 12)))
  const target = resolveOpTarget('set_bold', ctx.anchor, state.doc.content.size)
  assert.equal(target.ok, true)
  if (!target.ok) return
  assert.equal(target.from, 1)
  assert.equal(target.to, 6)
  assert.notEqual(target.from, state.selection.from)
})

test('target-dependent operation with no compatible request anchor fails closed', () => {
  const empty = { from: 0, to: 0, cursor: 0, selectedText: '' }
  const miss = resolveOpTarget('replace_selection', empty, 20)
  assert.equal(miss.ok, false)
  const badCursor = resolveOpTarget('insert_at_cursor', { from: -1, to: -1, cursor: -1, selectedText: '' }, 20)
  assert.equal(badCursor.ok, false)
})

test('mutating result is stale after a document edit', () => {
  let state = createState()
  const ctx = capture(state)
  state = state.apply(state.tr.insertText('!', 1))
  assert.equal(isMutatingResultStale({
    state,
    ctx,
    liveRequestId: ctx.requestId,
    liveThreadId: ctx.originatingThreadId,
  }), true)
})

test('document changed then Undo still stale under monotonic revision', () => {
  let state = createState()
  const ctx = capture(state)
  const before = state.doc
  state = state.apply(state.tr.insertText('!', 1))
  state = state.apply(state.tr.replaceWith(0, state.doc.content.size, before.content))
  assert.equal(state.doc.eq(ctx.documentNode), true)
  assert.notEqual(getDocumentRevision(state), ctx.documentRevision)
  assert.equal(isMutatingResultStale({
    state,
    ctx,
    liveRequestId: ctx.requestId,
    liveThreadId: ctx.originatingThreadId,
  }), true)
})

test('selection-only movement is not stale', () => {
  let state = createState()
  const ctx = capture(state)
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5)))
  assert.equal(isMutatingResultStale({
    state,
    ctx,
    liveRequestId: ctx.requestId,
    liveThreadId: ctx.originatingThreadId,
  }), false)
})

test('planOperations fails closed before any mutation when replace_selection has no range', () => {
  const ctx = capture(createState())
  ctx.anchor = { from: 3, to: 3, cursor: 3, selectedText: '' }
  const planned = planOperations([{ type: 'replace_selection', content: 'x' }], ctx, ctx.documentNode)
  assert.equal(planned.ok, false)
})

test('case 43: first request gets a concrete thread ID before RequestContext capture', () => {
  let created = 0
  const id = requireOwningThreadId(null, () => {
    created += 1
    return 'thread-first'
  })
  assert.equal(id, 'thread-first')
  assert.equal(created, 1)
  const state = createState()
  const ctx = captureRequestContext({
    requestId: 'req-first',
    source: 'panel',
    state,
    html: '<p>Hello world</p>',
    threadId: id!,
    modelId: 'm1',
  })
  assert.equal(ctx.originatingThreadId, 'thread-first')
  assert.notEqual(ctx.originatingThreadId, null)
})

test('case 44: no null-thread mismatch exemption remains', () => {
  const state = createState()
  const ctx = captureRequestContext({
    requestId: 'req-1',
    source: 'panel',
    state,
    html: '<p>Hello world</p>',
    threadId: 'thread-first',
    modelId: 'm1',
  })
  assert.equal(isMutatingResultStale({
    state,
    ctx,
    liveRequestId: ctx.requestId,
    liveThreadId: null,
  }), true)
})

test('case 45: first conversation cannot apply to a different thread', () => {
  const state = createState()
  const ctx = captureRequestContext({
    requestId: 'req-1',
    source: 'panel',
    state,
    html: '<p>Hello world</p>',
    threadId: 'thread-first',
    modelId: 'm1',
  })
  assert.equal(isMutatingResultStale({
    state,
    ctx,
    liveRequestId: ctx.requestId,
    liveThreadId: 'thread-other',
  }), true)
  assert.equal(isMutatingResultStale({
    state,
    ctx,
    liveRequestId: ctx.requestId,
    liveThreadId: 'thread-first',
  }), false)
})

test('requireOwningThreadId reuses a live id and rejects empty create', () => {
  assert.equal(requireOwningThreadId('existing', () => 'new'), 'existing')
  assert.equal(requireOwningThreadId(null, () => ''), null)
  assert.equal(requireOwningThreadId('', () => 'created'), 'created')
})

test('request latch allows exactly one in-flight request', () => {
  resetRequestLatch()
  const a = tryBeginRequest()
  assert.notEqual(a, false)
  assert.equal(tryBeginRequest(), false)
  assert.equal(isRequestInFlight(), true)
  assert.equal(getInFlightRequestId(), a)
  finishRequest(a as string)
  assert.equal(isRequestInFlight(), false)
  assert.notEqual(tryBeginRequest(), false)
  resetRequestLatch()
})
