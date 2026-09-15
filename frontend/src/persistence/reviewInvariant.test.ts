import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canPersistCommittedDocument, persistableHtml, type ReviewPhase } from '../ai/reviewTransaction.ts'
import { SkipPersistError } from './errors.ts'
import { createSaveCoordinator } from './saveCoordinator.ts'

function snapshotProvider(phase: ReviewPhase, snapshot: string | null, editorHtml: string): string {
  if (!canPersistCommittedDocument(phase, snapshot)) throw new SkipPersistError()
  return persistableHtml(phase, snapshot, editorHtml)
}

test('snapshot provider returns committed A while review is pending', () => {
  const A = '<p>committed A</p>'
  const B = '<p>proposal B</p>'
  assert.equal(snapshotProvider('pending', A, B), A)
  assert.notEqual(snapshotProvider('pending', A, B), B)
})

test('pending without snapshot cannot persist the proposal', () => {
  const B = '<p>proposal B</p>'
  assert.throws(() => snapshotProvider('pending', null, B), SkipPersistError)
})

test('Accept then persist uses B; Reject then persist uses restored A', async () => {
  const A = '<p>A</p>'
  const B = '<p>B</p>'
  let phase: ReviewPhase = 'idle'
  let snapshot: string | null = null
  let editorHtml = A
  const durable: string[] = []
  const coordinator = createSaveCoordinator({
    debounceMs: 0,
    getSnapshot: () => snapshotProvider(phase, snapshot, editorHtml),
    persist: async (html) => {
      durable.push(html)
      return { savedAt: 't' }
    },
  })

  await coordinator.flushNow()
  assert.equal(durable.at(-1), A)

  snapshot = A
  phase = 'pending'
  editorHtml = B
  await coordinator.flushNow()
  assert.equal(durable.at(-1), A)

  phase = 'committed'
  snapshot = null
  editorHtml = B
  await coordinator.flushNow()
  assert.equal(durable.at(-1), B)

  snapshot = B
  phase = 'pending'
  editorHtml = '<p>C</p>'
  await coordinator.flushNow()
  assert.equal(durable.at(-1), B)

  phase = 'rejected'
  snapshot = null
  editorHtml = B
  await coordinator.flushNow()
  assert.equal(durable.at(-1), B)
  coordinator.dispose()
})
