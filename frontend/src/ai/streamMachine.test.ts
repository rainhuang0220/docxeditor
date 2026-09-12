import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialState, reduce, type ChatEvent, type Effect, type MachineState } from './streamMachine.ts'

function apply(state: MachineState, event: ChatEvent): { state: MachineState; effects: Effect[] } {
  return reduce(state, event)
}

function start(): MachineState {
  return apply(initialState(), { type: 'start' }).state
}

test('start → tool_delta → eof restores once', () => {
  let state = start()
  state = apply(state, { type: 'tool_delta', name: 'replace_content' }).state
  const eof = apply(state, { type: 'eof' })
  assert.equal(eof.state.phase, 'incomplete')
  assert.deepEqual(eof.effects, ['stopLive', 'restore', 'markIncomplete'])
  const again = apply(eof.state, { type: 'eof' })
  assert.deepEqual(again.effects, [])
})

test('start → eof with no live write does not restore', () => {
  const eof = apply(start(), { type: 'eof' })
  assert.equal(eof.state.phase, 'incomplete')
  assert.deepEqual(eof.effects, ['stopLive', 'markIncomplete'])
  assert.equal(eof.effects.includes('restore'), false)
})

test('start → done(ops>0) → eof applies once and eof is a no-op', () => {
  const done = apply(start(), { type: 'done', operationsCount: 2 })
  assert.equal(done.state.phase, 'completed')
  assert.deepEqual(done.effects, ['stopLive', 'applyResult'])
  const eof = apply(done.state, { type: 'eof' })
  assert.deepEqual(eof.effects, [])
  assert.equal(eof.state.phase, 'completed')
})

test('start → done(ops>0) → error does not restore', () => {
  const done = apply(start(), { type: 'done', operationsCount: 1 })
  const err = apply(done.state, { type: 'error' })
  assert.deepEqual(err.effects, [])
  assert.equal(err.state.phase, 'completed')
})

test('start → error → done restores once and does not apply', () => {
  let state = start()
  state = apply(state, { type: 'tool_start', name: 'replace_content' }).state
  const err = apply(state, { type: 'error' })
  assert.equal(err.state.phase, 'failed')
  assert.deepEqual(err.effects, ['stopLive', 'restore'])
  const done = apply(err.state, { type: 'done', operationsCount: 3 })
  assert.deepEqual(done.effects, [])
  assert.equal(done.effects.includes('applyResult'), false)
})

test('start → done → done emits applyResult once', () => {
  const first = apply(start(), { type: 'done', operationsCount: 1 })
  assert.deepEqual(first.effects, ['stopLive', 'applyResult'])
  const second = apply(first.state, { type: 'done', operationsCount: 1 })
  assert.deepEqual(second.effects, [])
})

test('start → live → done(ops=0) restores', () => {
  let state = start()
  state = apply(state, { type: 'tool_start', name: 'insert_at_end' }).state
  const done = apply(state, { type: 'done', operationsCount: 0 })
  assert.equal(done.state.phase, 'completed')
  assert.deepEqual(done.effects, ['stopLive', 'restore'])
})

test('start → abort after live restores and marks aborted', () => {
  let state = start()
  state = apply(state, { type: 'tool_delta', name: 'replace_content' }).state
  const abort = apply(state, { type: 'abort' })
  assert.equal(abort.state.phase, 'aborted')
  assert.deepEqual(abort.effects, ['stopLive', 'restore'])
})

test('start → abort after done is a no-op', () => {
  const done = apply(start(), { type: 'done', operationsCount: 1 })
  const abort = apply(done.state, { type: 'abort' })
  assert.deepEqual(abort.effects, [])
  assert.equal(abort.state.phase, 'completed')
})

test('start → fallback(ops) emits applyResult once', () => {
  const fallback = apply(start(), { type: 'fallback', operationsCount: 2 })
  assert.equal(fallback.state.phase, 'completed')
  assert.deepEqual(fallback.effects, ['stopLive', 'applyResult'])
  const again = apply(fallback.state, { type: 'fallback', operationsCount: 2 })
  assert.deepEqual(again.effects, [])
})

test('start → fallback(0) with no live does not restore', () => {
  const fallback = apply(start(), { type: 'fallback', operationsCount: 0 })
  assert.equal(fallback.state.phase, 'completed')
  assert.deepEqual(fallback.effects, ['stopLive'])
})

test('tool_delta after a terminal is a no-op', () => {
  const failed = apply(start(), { type: 'error' })
  const delta = apply(failed.state, { type: 'tool_delta', name: 'replace_content' })
  assert.deepEqual(delta.effects, [])
  assert.equal(delta.state.mutated, false)
  assert.equal(delta.state.phase, 'failed')
})
