import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialState, reduce } from './streamMachine.ts'
import {
  guardReviewAction,
  initialReviewState,
  persistableHtml,
  canExportDocument,
  planDeleteModel,
  reduceReview,
  type ReviewEffect,
  type ReviewState,
  type SessionAction,
} from './reviewTransaction.ts'

const ORIGINAL = '<p>original</p>'
const PROPOSED = '<p>proposed</p>'

interface FakeDoc {
  html: string
  snapshot: string
  apply: number
  restore: number
  commit: number
}

function freshDoc(): FakeDoc {
  return { html: ORIGINAL, snapshot: ORIGINAL, apply: 0, restore: 0, commit: 0 }
}

function runStream(events: Parameters<typeof reduce>[1][]) {
  let state = initialState()
  const effects: string[] = []
  for (const event of events) {
    const out = reduce(state, event)
    state = out.state
    effects.push(...out.effects)
  }
  return { state, effects }
}

function interpretReview(doc: FakeDoc, effects: ReviewEffect[]) {
  for (const effect of effects) {
    if (effect === 'restore') {
      doc.html = doc.snapshot
      doc.restore++
    }
    if (effect === 'commit') {
      doc.commit++
      doc.snapshot = ''
    }
    if (effect === 'clearSnapshot') {
      doc.snapshot = ''
    }
  }
}

function applyStreamToDoc(doc: FakeDoc, effects: string[]) {
  for (const effect of effects) {
    if (effect === 'applyResult') {
      doc.html = PROPOSED
      doc.apply++
    }
  }
}

function pendingReview(doc: FakeDoc): ReviewState {
  const stream = runStream([
    { type: 'start' },
    { type: 'done', operationsCount: 1 },
  ])
  applyStreamToDoc(doc, stream.effects)
  const review = reduceReview(initialReviewState(), {
    type: 'applied',
    operationsCount: 1,
    confirmable: true,
  })
  interpretReview(doc, review.effects)
  assert.equal(review.state.phase, 'pending')
  return review.state
}

test('start → tool_start → many tool_delta → canonical mutation effect count = 0', () => {
  const doc = freshDoc()
  const events: Parameters<typeof reduce>[1][] = [{ type: 'start' }, { type: 'tool_start', name: 'replace_content' }]
  for (let i = 0; i < 24; i++) events.push({ type: 'tool_delta', name: 'replace_content' })
  const out = runStream(events)
  applyStreamToDoc(doc, out.effects)
  assert.equal(out.state.phase, 'streaming')
  assert.deepEqual(out.effects, [])
  assert.equal(doc.apply, 0)
  assert.equal(doc.html, ORIGINAL)
})

test('start → tool_delta → EOF → incomplete, document unchanged, no restore needed', () => {
  const doc = freshDoc()
  const out = runStream([
    { type: 'start' },
    { type: 'tool_delta', name: 'replace_content' },
    { type: 'eof' },
  ])
  applyStreamToDoc(doc, out.effects)
  assert.equal(out.state.phase, 'incomplete')
  assert.deepEqual(out.effects, ['markIncomplete'])
  assert.equal(doc.html, ORIGINAL)
  assert.equal(doc.restore, 0)
})

test('start → tool_delta → abort → document unchanged', () => {
  const doc = freshDoc()
  const out = runStream([
    { type: 'start' },
    { type: 'tool_delta', name: 'replace_content' },
    { type: 'abort' },
  ])
  applyStreamToDoc(doc, out.effects)
  assert.equal(out.state.phase, 'aborted')
  assert.deepEqual(out.effects, [])
  assert.equal(doc.html, ORIGINAL)
})

test('valid done with mutation → final application exactly once', () => {
  const doc = freshDoc()
  let state = initialState()
  const first = reduce(state, { type: 'start' })
  state = first.state
  const done = reduce(state, { type: 'done', operationsCount: 2 })
  applyStreamToDoc(doc, done.effects)
  const again = reduce(done.state, { type: 'done', operationsCount: 2 })
  applyStreamToDoc(doc, again.effects)
  assert.deepEqual(done.effects, ['applyResult'])
  assert.deepEqual(again.effects, [])
  assert.equal(doc.apply, 1)
  assert.equal(doc.html, PROPOSED)
})

test('completed confirmable mutation → review pending', () => {
  const doc = freshDoc()
  const stream = runStream([{ type: 'start' }, { type: 'done', operationsCount: 1 }])
  applyStreamToDoc(doc, stream.effects)
  const review = reduceReview(initialReviewState(), {
    type: 'applied',
    operationsCount: 1,
    confirmable: true,
  })
  interpretReview(doc, review.effects)
  assert.equal(review.state.phase, 'pending')
  assert.deepEqual(review.effects, ['enterPending'])
  assert.equal(doc.html, PROPOSED)
})

function assertBlocked(state: ReviewState, doc: FakeDoc, action: SessionAction) {
  const before = { ...doc }
  const out = guardReviewAction(state, action)
  interpretReview(doc, out.effects)
  assert.equal(out.allowed, false)
  assert.equal(out.state.phase, 'pending')
  assert.deepEqual(out.effects, [])
  assert.equal(doc.html, before.html)
  assert.equal(doc.snapshot, before.snapshot)
}

test('pending review → second send → blocked, review+snapshot retained, document unchanged', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  assertBlocked(state, doc, 'send')
})

test('pending review → new chat → blocked and retained', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  assertBlocked(state, doc, 'newChat')
})

test('pending review → thread switch → blocked and retained', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  assertBlocked(state, doc, 'switchThread')
})

test('pending review → model switch → blocked and retained', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  assertBlocked(state, doc, 'switchModel')
})

test('pending review → Accept → commit/clear exactly once', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  const out = reduceReview(state, { type: 'accept' })
  interpretReview(doc, out.effects)
  assert.equal(out.state.phase, 'committed')
  assert.deepEqual(out.effects, ['commit'])
  assert.equal(doc.html, PROPOSED)
  assert.equal(doc.commit, 1)
  assert.equal(doc.snapshot, '')
})

test('double Accept → second no-op, only one version/audit save', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  const first = reduceReview(state, { type: 'accept' })
  interpretReview(doc, first.effects)
  const second = reduceReview(first.state, { type: 'accept' })
  interpretReview(doc, second.effects)
  assert.deepEqual(second.effects, [])
  assert.equal(doc.commit, 1)
})

test('pending review → Reject → exact pre-request document restored once', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  assert.equal(doc.html, PROPOSED)
  const out = reduceReview(state, { type: 'reject' })
  interpretReview(doc, out.effects)
  assert.equal(out.state.phase, 'rejected')
  assert.deepEqual(out.effects, ['restore'])
  assert.equal(doc.html, ORIGINAL)
  assert.equal(doc.restore, 1)
})

test('double Reject → second no-op', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  const first = reduceReview(state, { type: 'reject' })
  interpretReview(doc, first.effects)
  const second = reduceReview(first.state, { type: 'reject' })
  interpretReview(doc, second.effects)
  assert.deepEqual(second.effects, [])
  assert.equal(doc.restore, 1)
  assert.equal(doc.html, ORIGINAL)
})

test('Accept then stale Reject → committed document remains', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  const accepted = reduceReview(state, { type: 'accept' })
  interpretReview(doc, accepted.effects)
  const stale = reduceReview(accepted.state, { type: 'reject' })
  interpretReview(doc, stale.effects)
  assert.deepEqual(stale.effects, [])
  assert.equal(doc.html, PROPOSED)
  assert.equal(doc.restore, 0)
})

test('Reject then stale Accept → restored document remains', () => {
  const doc = freshDoc()
  const state = pendingReview(doc)
  const rejected = reduceReview(state, { type: 'reject' })
  interpretReview(doc, rejected.effects)
  const stale = reduceReview(rejected.state, { type: 'accept' })
  interpretReview(doc, stale.effects)
  assert.deepEqual(stale.effects, [])
  assert.equal(doc.html, ORIGINAL)
  assert.equal(doc.commit, 0)
})

test('pending review persistable HTML is the request snapshot, not the provisional editor', () => {
  assert.equal(persistableHtml('pending', ORIGINAL, PROPOSED), ORIGINAL)
  assert.equal(persistableHtml('pending', '', PROPOSED), '')
  assert.equal(persistableHtml('idle', null, PROPOSED), PROPOSED)
  assert.equal(persistableHtml('committed', null, PROPOSED), PROPOSED)
})

test('deleting active model while review pending → blocked', () => {
  const review = { phase: 'pending' as const }
  const out = planDeleteModel({
    models: [{ id: 'a' }, { id: 'b' }],
    activeModelId: 'a',
    deleteId: 'a',
    review,
  })
  assert.equal(out.allowed, false)
  assert.deepEqual(out.models, [{ id: 'a' }, { id: 'b' }])
  assert.equal(out.activeModelId, 'a')
  assert.equal(out.review.phase, 'pending')
})

test('pending review export is refused', () => {
  const pending = pendingReview(freshDoc())
  const out = guardReviewAction(pending, 'export')
  assert.equal(out.allowed, false)
  assert.equal(canExportDocument('pending'), false)
  assert.equal(canExportDocument('idle'), true)
  assert.equal(canExportDocument('committed'), true)
  assert.equal(canExportDocument('rejected'), true)
})

test('deleting inactive model while review pending → does not change active model or review state', () => {
  const review = { phase: 'pending' as const }
  const out = planDeleteModel({
    models: [{ id: 'a' }, { id: 'b' }],
    activeModelId: 'a',
    deleteId: 'b',
    review,
  })
  assert.equal(out.allowed, true)
  assert.deepEqual(out.models, [{ id: 'a' }])
  assert.equal(out.activeModelId, 'a')
  assert.equal(out.review.phase, 'pending')
})
