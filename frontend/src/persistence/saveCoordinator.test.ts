import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SkipPersistError } from './errors.ts'
import { createSaveCoordinator } from './saveCoordinator.ts'
import { createFakeClock, deferred } from './testUtils.ts'
import type { PersistenceStatus } from './types.ts'

test('scheduleSave does not capture HTML at schedule time', async () => {
  const clock = createFakeClock()
  let live = 'A'
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  live = 'B'
  await clock.advance(800)
  await Promise.resolve()
  assert.deepEqual(writes, ['B'])
  coordinator.dispose()
})

test('slow A then newer B → durable B (never A after B)', async () => {
  const clock = createFakeClock()
  let live = 'A'
  const writes: string[] = []
  const gateA = deferred<void>()
  let persistCalls = 0
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      persistCalls += 1
      if (html === 'A') await gateA.promise
      writes.push(html)
      return { savedAt: `t-${writes.length}` }
    },
  })
  coordinator.scheduleSave()
  await clock.advance(800)
  const savingA = Promise.resolve()
  await savingA
  live = 'B'
  coordinator.scheduleSave()
  await clock.advance(800)
  gateA.resolve()
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'B')
  assert.ok(persistCalls >= 1)
  const aAfterB = writes.findIndex((html, i) => html === 'A' && writes.slice(i + 1).includes('B') === false && i > writes.lastIndexOf('B'))
  assert.equal(aAfterB, -1)
  coordinator.dispose()
})

test('multiple rapid edits coalesce to latest state', async () => {
  const clock = createFakeClock()
  let live = '0'
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  for (let i = 1; i <= 8; i++) {
    live = String(i)
    coordinator.scheduleSave()
  }
  await clock.advance(800)
  await coordinator.flushNow()
  assert.equal(writes.at(-1), '8')
  assert.ok(writes.length <= 2)
  coordinator.dispose()
})

test('flushNow persists latest committed snapshot immediately', async () => {
  const clock = createFakeClock()
  let live = 'draft'
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  live = 'flushed'
  await coordinator.flushNow()
  assert.deepEqual(writes, ['flushed'])
  coordinator.dispose()
})

test('save failure is error/dirty, never clean/Saved', async () => {
  const statuses: PersistenceStatus[] = []
  const coordinator = createSaveCoordinator({
    debounceMs: 0,
    getSnapshot: () => 'X',
    persist: async () => {
      throw new Error('disk full')
    },
    onStatus: (status) => statuses.push(status),
  })
  const outcome = await coordinator.flushNow()
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.kind, 'error')
  assert.equal(coordinator.getStatus().kind, 'error')
  assert.ok(statuses.every(status => status.kind !== 'clean'))
  coordinator.dispose()
})

test('1. imperative flushNow reports success explicitly', async () => {
  const coordinator = createSaveCoordinator({
    getSnapshot: () => 'A',
    persist: async () => ({ savedAt: '2026-09-15T12:00:00.000Z' }),
  })
  const outcome = await coordinator.flushNow()
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.savedAt, '2026-09-15T12:00:00.000Z')
  coordinator.dispose()
})

test('2. imperative flushNow reports write failure explicitly', async () => {
  const coordinator = createSaveCoordinator({
    getSnapshot: () => 'A',
    persist: async () => {
      throw new Error('write failed')
    },
  })
  const outcome = await coordinator.flushNow()
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.equal(outcome.kind, 'error')
    assert.equal(outcome.message, 'write failed')
  }
  coordinator.dispose()
})

test('3. failed flushNow never reports clean', async () => {
  const coordinator = createSaveCoordinator({
    getSnapshot: () => 'A',
    persist: async () => {
      throw new Error('write failed')
    },
  })
  await coordinator.flushNow()
  assert.notEqual(coordinator.getStatus().kind, 'clean')
  coordinator.dispose()
})

test('4. failed save followed by later successful retry reaches clean and persists latest state', async () => {
  const writes: string[] = []
  let fail = true
  const coordinator = createSaveCoordinator({
    getSnapshot: () => fail ? 'A' : 'B',
    persist: async (html) => {
      if (html === 'A' && fail) throw new Error('transient')
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  const first = await coordinator.flushNow()
  assert.equal(first.ok, false)
  assert.equal(coordinator.getStatus().kind, 'error')
  fail = false
  const second = await coordinator.flushNow()
  assert.equal(second.ok, true)
  assert.equal(coordinator.getStatus().kind, 'clean')
  assert.deepEqual(writes, ['B'])
  coordinator.dispose()
})

test('5. beginDestructiveTransition failure does not bump generation', async () => {
  const coordinator = createSaveCoordinator({
    getSnapshot: () => 'A',
    persist: async () => {
      throw new Error('write failed')
    },
  })
  const before = coordinator.getGeneration()
  const outcome = await coordinator.beginDestructiveTransition()
  assert.equal(outcome.ok, false)
  assert.equal(coordinator.getGeneration(), before)
  coordinator.dispose()
})

test('6. failure does not clear dirty state', async () => {
  const coordinator = createSaveCoordinator({
    getSnapshot: () => 'A',
    persist: async () => {
      throw new Error('write failed')
    },
  })
  await coordinator.flushNow()
  assert.equal(coordinator.getStatus().kind, 'error')
  const again = await coordinator.flushNow()
  assert.equal(again.ok, false)
  coordinator.dispose()
})

test('queued save from old document cannot overwrite a later replacement', async () => {
  const clock = createFakeClock()
  let live = 'OLD'
  const writes: string[] = []
  const gateOld = deferred<void>()
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      if (html === 'OLD') await gateOld.promise
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  await clock.advance(800)
  const replacing = coordinator.beginDestructiveTransition()
  gateOld.resolve()
  await replacing
  live = 'NEW'
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'NEW')
  coordinator.dispose()
})

test('pending snapshot skip does not persist proposal HTML', async () => {
  const writes: string[] = []
  let skip = true
  const coordinator = createSaveCoordinator({
    debounceMs: 0,
    getSnapshot: () => {
      if (skip) throw new SkipPersistError()
      return 'A'
    },
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  await coordinator.flushNow()
  assert.deepEqual(writes, [])
  skip = false
  await coordinator.flushNow()
  assert.deepEqual(writes, ['A'])
  coordinator.dispose()
})
