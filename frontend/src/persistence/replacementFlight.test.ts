import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isDocumentMutationLocked,
  isDestructiveReplacementInFlight,
  resetDocumentMutationLatchForTests,
  tryAcquireDocumentMutationLock,
  tryBeginDestructiveReplacement,
} from '../ai/mutationLatch.ts'
import { createHeadlessEditor } from '../test/headlessEditor.ts'
import { applyVerifiedReplacement } from './editorReplacement.ts'
import {
  REPLACEMENT_BUSY_MESSAGE,
  runDestructiveReplacement,
} from './destructivePrepare.ts'
import { deferred } from './testUtils.ts'
import type { VersionOutcome } from './types.ts'

function okVersion(html: string): VersionOutcome {
  return {
    ok: true,
    version: {
      id: 'v1',
      timestamp: '2026-09-15T12:00:00.000Z',
      description: 'checkpoint',
      content: html,
    },
  }
}

function baseDeps(overrides: Partial<Parameters<typeof runDestructiveReplacement>[0]> = {}) {
  let generation = 0
  const flushes: string[] = []
  const versions: string[] = []
  const applied: string[] = []
  const deps = {
    nextHtml: '<p>B</p>',
    description: 'Before new document',
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => {
      flushes.push('flush')
      return { ok: true as const, savedAt: 't' }
    },
    createVersion: async (_d: string, html: string) => {
      versions.push(html)
      return okVersion(html)
    },
    beginDestructiveTransition: async () => {
      generation += 1
      return { ok: true as const, savedAt: 't' }
    },
    apply: (html: string) => {
      applied.push(html)
      return true
    },
    ...overrides,
  }
  return { deps, generation: () => generation, flushes, versions, applied }
}

test('1. first destructive prepare acquires exclusive ownership', async () => {
  resetDocumentMutationLatchForTests()
  const { deps } = baseDeps()
  const result = await runDestructiveReplacement(deps)
  assert.equal(result.replaced, true)
  assert.equal(isDestructiveReplacementInFlight(), false)
  assert.equal(isDocumentMutationLocked(), false)
})

test('2. second overlapping prepare is rejected/skipped immediately', async () => {
  resetDocumentMutationLatchForTests()
  const gate = deferred<void>()
  const first = baseDeps({
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
  })
  const second = baseDeps({
    description: 'Before import',
    nextHtml: '<p>C</p>',
  })
  const p1 = runDestructiveReplacement(first.deps)
  const p2 = runDestructiveReplacement(second.deps)
  const r2 = await p2
  assert.equal(r2.ok, false)
  assert.equal(r2.replaced, false)
  if (!r2.ok) {
    assert.equal(r2.kind, 'skipped')
    assert.equal(r2.message, REPLACEMENT_BUSY_MESSAGE)
  }
  gate.resolve()
  const r1 = await p1
  assert.equal(r1.replaced, true)
})

test('3. second attempt does not call flush', async () => {
  resetDocumentMutationLatchForTests()
  const gate = deferred<void>()
  const first = baseDeps({
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
  })
  const second = baseDeps()
  const p1 = runDestructiveReplacement(first.deps)
  await runDestructiveReplacement(second.deps)
  gate.resolve()
  await p1
  assert.equal(second.flushes.length, 0)
})

test('4. second attempt does not create recovery version', async () => {
  resetDocumentMutationLatchForTests()
  const gate = deferred<void>()
  const first = baseDeps({
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
  })
  const second = baseDeps()
  const p1 = runDestructiveReplacement(first.deps)
  await runDestructiveReplacement(second.deps)
  gate.resolve()
  await p1
  assert.equal(second.versions.length, 0)
})

test('5. second attempt does not bump generation', async () => {
  resetDocumentMutationLatchForTests()
  const gate = deferred<void>()
  const first = baseDeps({
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
  })
  const second = baseDeps()
  const p1 = runDestructiveReplacement(first.deps)
  await runDestructiveReplacement(second.deps)
  gate.resolve()
  await p1
  assert.equal(second.generation(), 0)
  assert.equal(first.generation(), 1)
})

test('6. double New Document cannot produce two replacements', async () => {
  resetDocumentMutationLatchForTests()
  const gate = deferred<void>()
  const first = baseDeps({
    description: 'Before new document',
    nextHtml: '<p>N1</p>',
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
  })
  const second = baseDeps({
    description: 'Before new document',
    nextHtml: '<p>N2</p>',
  })
  const p1 = runDestructiveReplacement(first.deps)
  const r2 = await runDestructiveReplacement(second.deps)
  gate.resolve()
  const r1 = await p1
  assert.equal(r1.replaced, true)
  assert.equal(r2.replaced, false)
  assert.deepEqual(first.applied, ['<p>N1</p>'])
  assert.deepEqual(second.applied, [])
})

test('7. import overlapping New Document cannot produce two replacements', async () => {
  resetDocumentMutationLatchForTests()
  const gate = deferred<void>()
  const doc = baseDeps({
    description: 'Before new document',
    nextHtml: '<p>New</p>',
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
  })
  const imp = baseDeps({
    description: 'Before import',
    nextHtml: '<p>Imported</p>',
  })
  const p1 = runDestructiveReplacement(doc.deps)
  const r2 = await runDestructiveReplacement(imp.deps)
  gate.resolve()
  const r1 = await p1
  assert.equal(r1.replaced, true)
  assert.equal(r2.replaced, false)
  assert.deepEqual(imp.applied, [])
})

test('8. two restore attempts cannot both apply', async () => {
  resetDocumentMutationLatchForTests()
  const gate = deferred<void>()
  const a = baseDeps({
    description: 'Auto-save before restore',
    nextHtml: '<p>V1</p>',
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
  })
  const b = baseDeps({
    description: 'Auto-save before restore',
    nextHtml: '<p>V2</p>',
  })
  const p1 = runDestructiveReplacement(a.deps)
  const r2 = await runDestructiveReplacement(b.deps)
  gate.resolve()
  const r1 = await p1
  assert.equal(r1.replaced, true)
  assert.equal(r2.replaced, false)
  assert.deepEqual(b.applied, [])
})

test('9. first succeeds + second rejected → first replacement actually becomes canonical', async () => {
  resetDocumentMutationLatchForTests()
  const harness = createHeadlessEditor({ html: '<p>A</p>' })
  const gate = deferred<void>()
  const first = runDestructiveReplacement({
    nextHtml: '<p>B</p>',
    description: 'Before new document',
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => {
      await gate.promise
      return { ok: true, savedAt: 't' }
    },
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
    apply: html => applyVerifiedReplacement(harness.editor, html),
  })
  const second = runDestructiveReplacement({
    nextHtml: '<p>C</p>',
    description: 'Before import',
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
    apply: html => applyVerifiedReplacement(harness.editor, html),
  })
  const r2 = await second
  gate.resolve()
  const r1 = await first
  assert.equal(r1.replaced, true)
  assert.equal(r2.replaced, false)
  assert.equal(harness.editor.state.doc.textContent.trim(), 'B')
  harness.destroy()
  resetDocumentMutationLatchForTests()
})

test('10. first fails + later retry can acquire ownership and succeed', async () => {
  resetDocumentMutationLatchForTests()
  const fail = await runDestructiveReplacement(baseDeps({
    flushNow: async () => ({ ok: false, kind: 'error', message: 'write failed' }),
  }).deps)
  assert.equal(fail.replaced, false)
  assert.equal(isDestructiveReplacementInFlight(), false)
  const retry = await runDestructiveReplacement(baseDeps({
    nextHtml: '<p>Retry</p>',
  }).deps)
  assert.equal(retry.replaced, true)
})

test('11. snapshot throw releases ownership', async () => {
  resetDocumentMutationLatchForTests()
  const result = await runDestructiveReplacement(baseDeps({
    getSnapshot: () => {
      throw new Error('snapshot boom')
    },
  }).deps)
  assert.equal(result.replaced, false)
  assert.equal(isDocumentMutationLocked(), false)
  assert.equal(isDestructiveReplacementInFlight(), false)
})

test('12. flush failure releases ownership', async () => {
  resetDocumentMutationLatchForTests()
  await runDestructiveReplacement(baseDeps({
    flushNow: async () => ({ ok: false, kind: 'error', message: 'write failed' }),
  }).deps)
  assert.equal(isDocumentMutationLocked(), false)
  assert.equal(isDestructiveReplacementInFlight(), false)
})

test('13. version failure releases ownership', async () => {
  resetDocumentMutationLatchForTests()
  await runDestructiveReplacement(baseDeps({
    createVersion: async () => ({ ok: false, kind: 'error', message: 'version failed' }),
  }).deps)
  assert.equal(isDocumentMutationLocked(), false)
  assert.equal(isDestructiveReplacementInFlight(), false)
})

test('14. generation-transition failure releases ownership', async () => {
  resetDocumentMutationLatchForTests()
  await runDestructiveReplacement(baseDeps({
    beginDestructiveTransition: async () => ({ ok: false, kind: 'error', message: 'transition failed' }),
  }).deps)
  assert.equal(isDocumentMutationLocked(), false)
  assert.equal(isDestructiveReplacementInFlight(), false)
})

test('15. replacement callback/command failure releases ownership', async () => {
  resetDocumentMutationLatchForTests()
  const result = await runDestructiveReplacement(baseDeps({
    apply: () => {
      throw new Error('apply failed')
    },
  }).deps)
  assert.equal(result.replaced, false)
  assert.equal(isDocumentMutationLocked(), false)
  assert.equal(isDestructiveReplacementInFlight(), false)
})

test('16. release is idempotent', () => {
  resetDocumentMutationLatchForTests()
  const lease = tryAcquireDocumentMutationLock()
  assert.ok(lease)
  lease!.release()
  lease!.release()
  const next = tryAcquireDocumentMutationLock()
  assert.ok(next)
  const stale = tryAcquireDocumentMutationLock()
  assert.equal(stale, null)
  lease!.release()
  assert.equal(isDocumentMutationLocked(), true)
  next!.release()
  assert.equal(isDocumentMutationLocked(), false)
  const flight = tryBeginDestructiveReplacement()
  assert.ok(flight)
  flight!.release()
  flight!.release()
  assert.equal(isDestructiveReplacementInFlight(), false)
})

test('17. replaced: true only when setContent actually took effect', async () => {
  resetDocumentMutationLatchForTests()
  const harness = createHeadlessEditor({ html: '<p>A</p>' })
  const result = await runDestructiveReplacement({
    nextHtml: '<p>B</p>',
    description: 'Before new document',
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
    apply: html => applyVerifiedReplacement(harness.editor, html),
  })
  assert.equal(result.replaced, true)
  assert.equal(harness.editor.state.doc.textContent.trim(), 'B')
  harness.destroy()
  resetDocumentMutationLatchForTests()
})

test('18. filtered/blocked setContent cannot return replaced: true', async () => {
  resetDocumentMutationLatchForTests()
  let pending = true
  const harness = createHeadlessEditor({
    html: '<p>A</p>',
    isLocked: () => pending,
  })
  const result = await runDestructiveReplacement({
    nextHtml: '<p>B</p>',
    description: 'Before new document',
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
    apply: html => applyVerifiedReplacement(harness.editor, html),
  })
  assert.equal(result.replaced, false)
  assert.equal(harness.editor.state.doc.textContent.trim(), 'A')
  pending = false
  harness.destroy()
  resetDocumentMutationLatchForTests()
})

test('19. no mutation lock remains after every failure case', async () => {
  resetDocumentMutationLatchForTests()
  await runDestructiveReplacement(baseDeps({
    flushNow: async () => ({ ok: false, kind: 'error', message: 'x' }),
  }).deps)
  await runDestructiveReplacement(baseDeps({
    getSnapshot: () => { throw new Error('x') },
  }).deps)
  await runDestructiveReplacement(baseDeps({
    apply: () => false,
  }).deps)
  assert.equal(isDocumentMutationLocked(), false)
  assert.equal(isDestructiveReplacementInFlight(), false)
})

test('20. existing user-edit-during-prepare protection still works', async () => {
  resetDocumentMutationLatchForTests()
  const harness = createHeadlessEditor({
    html: '<p>A</p>',
    isLocked: () => isDocumentMutationLocked(),
  })
  const lease = tryAcquireDocumentMutationLock()
  assert.ok(lease)
  const before = harness.editor.state.doc.textContent
  harness.editor.commands.insertContent('Z')
  assert.equal(harness.editor.state.doc.textContent, before)
  lease!.release()
  harness.destroy()
  resetDocumentMutationLatchForTests()
})
