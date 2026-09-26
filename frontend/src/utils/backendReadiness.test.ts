import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STILL_STARTING_AFTER_MS, backendReadinessView } from './backendReadiness.ts'

test('starting then still-starting before ready; failed stays offline with retry', () => {
  const early = backendReadinessView('starting', 0, false)
  assert.equal(early.label, 'Starting…')
  assert.equal(early.tone, 'progress')
  assert.equal(early.canRetry, false)

  const mid = backendReadinessView('authenticating', STILL_STARTING_AFTER_MS, false)
  assert.equal(mid.label, 'Still starting…')
  assert.equal(mid.tone, 'progress')
  assert.equal(mid.canRetry, false)

  const ready = backendReadinessView('ready', 60_000, true)
  assert.equal(ready.label, 'AI Ready')
  assert.equal(ready.tone, 'ready')
  assert.equal(ready.canRetry, false)

  const failed = backendReadinessView('failed', 60_000, false)
  assert.equal(failed.label, 'Offline')
  assert.equal(failed.tone, 'failed')
  assert.equal(failed.canRetry, true)
})

test('health ready wins even if phase lags; unknown does not look dead', () => {
  assert.equal(backendReadinessView('authenticating', 1_000, true).label, 'AI Ready')
  assert.equal(backendReadinessView(null, 0, null).label, 'Starting…')
  assert.equal(backendReadinessView(null, 0, null).tone, 'progress')
})

test('unknown phase stays starting when first health probe fails', () => {
  // StatusBar fires health and backend_status in parallel; health can lose the race.
  const view = backendReadinessView(null, 0, false)
  assert.equal(view.label, 'Starting…')
  assert.equal(view.tone, 'progress')
  assert.equal(view.canRetry, false)

  // Once phase is known and not starting, health failure is still Offline.
  const known = backendReadinessView('unavailable', 0, false)
  assert.equal(known.label, 'Offline')
  assert.equal(known.tone, 'failed')
  assert.equal(known.canRetry, true)
})

test('first rendered frame with no status yet is Starting, not Offline', () => {
  const frame = backendReadinessView(null, 0, null)
  assert.equal(frame.label, 'Starting…')
  assert.equal(frame.tone, 'progress')
  assert.equal(frame.canRetry, false)
})

test('starting and authenticating disable Retry even when health is false', () => {
  for (const phase of ['starting', 'authenticating'] as const) {
    const view = backendReadinessView(phase, 100, false)
    assert.equal(view.canRetry, false, phase)
    assert.equal(view.tone, 'progress', phase)
  }
})

test('actual startup failure is Offline with Retry', () => {
  const view = backendReadinessView('failed', 12_000, false)
  assert.equal(view.label, 'Offline')
  assert.equal(view.tone, 'failed')
  assert.equal(view.canRetry, true)
})

test('post-start shutdown stopped is Offline, not Starting', () => {
  // A genuine stop after Ready must stay Offline; do not map every stopped to Starting.
  const view = backendReadinessView('stopped', 0, false)
  assert.equal(view.label, 'Offline')
  assert.equal(view.tone, 'failed')
  assert.equal(view.canRetry, true)
})

test('scheduled startup phase starting stays Starting before first health ok', () => {
  // Supervisor reports starting once startup is scheduled; first poll must not flash Offline.
  const view = backendReadinessView('starting', 0, false)
  assert.equal(view.label, 'Starting…')
  assert.equal(view.tone, 'progress')
  assert.equal(view.canRetry, false)
})
