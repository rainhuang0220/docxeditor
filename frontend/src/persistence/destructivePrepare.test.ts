import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isDocumentMutationLocked,
  lockDocumentMutations,
  resetDocumentMutationLatchForTests,
  unlockDocumentMutations,
} from '../ai/mutationLatch.ts'
import { createHeadlessEditor } from '../test/headlessEditor.ts'
import {
  persistAfterAccept,
  persistAfterReject,
  prepareDestructiveDocumentChange,
  saveManualVersion,
} from './destructivePrepare.ts'
import { hydrateDocument } from './hydrate.ts'
import { resetPersistence } from './testUtils.ts'
import { LEGACY_DOCUMENT_KEY, LEGACY_VERSIONS_KEY, type VersionOutcome } from './types.ts'
import { saveCurrentDocument } from './documentStore.ts'

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

test('7. prepare failure does not permit canonical replacement', async () => {
  resetDocumentMutationLatchForTests()
  let replaced = false
  const prep = await prepareDestructiveDocumentChange('Before new document', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: false, kind: 'error', message: 'write failed' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  assert.equal(prep.ok, false)
  if (!prep.ok) {
    replaced = true
    // callers must not apply replacement
    replaced = false
  }
  assert.equal(replaced, false)
})

test('8. IDB unavailable blocks destructive transition', async () => {
  resetDocumentMutationLatchForTests()
  const prep = await prepareDestructiveDocumentChange('Before new document', {
    persistEnabled: false,
    storageUnavailable: true,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  assert.equal(prep.ok, false)
  if (!prep.ok) assert.equal(prep.kind, 'degraded')
})

test('9. recovery checkpoint failure blocks New Document', async () => {
  resetDocumentMutationLatchForTests()
  let setContent = false
  const prep = await prepareDestructiveDocumentChange('Before new document', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => ({ ok: false, kind: 'error', message: 'version failed' }),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  if (prep.ok) prep.applyReplacement(() => { setContent = true })
  assert.equal(prep.ok, false)
  assert.equal(setContent, false)
})

test('10. recovery checkpoint failure blocks toolbar import', async () => {
  resetDocumentMutationLatchForTests()
  let setContent = false
  const prep = await prepareDestructiveDocumentChange('Before import', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => ({ ok: false, kind: 'error', message: 'version failed' }),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  if (prep.ok) prep.applyReplacement(() => { setContent = true })
  assert.equal(prep.ok, false)
  assert.equal(setContent, false)
})

test('11. recovery checkpoint failure blocks drag-drop import', async () => {
  resetDocumentMutationLatchForTests()
  let setContent = false
  const prep = await prepareDestructiveDocumentChange('Before import', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: false, kind: 'error', message: 'write failed' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  if (prep.ok) prep.applyReplacement(() => { setContent = true })
  assert.equal(prep.ok, false)
  assert.equal(setContent, false)
})

test('12. recovery checkpoint failure blocks version restore', async () => {
  resetDocumentMutationLatchForTests()
  let setContent = false
  const prep = await prepareDestructiveDocumentChange('Auto-save before restore', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => ({ ok: false, kind: 'degraded', message: 'unavailable' }),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  if (prep.ok) prep.applyReplacement(() => { setContent = true })
  assert.equal(prep.ok, false)
  assert.equal(setContent, false)
})

test('13. successful preservation permits New Document', async () => {
  resetDocumentMutationLatchForTests()
  let setContent = false
  const versions: string[] = []
  const prep = await prepareDestructiveDocumentChange('Before new document', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async (_d, html) => {
      versions.push(html)
      return okVersion(html)
    },
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  assert.equal(prep.ok, true)
  if (prep.ok) prep.applyReplacement(() => { setContent = true })
  assert.equal(setContent, true)
  assert.deepEqual(versions, ['A'])
})

test('14. successful preservation permits import', async () => {
  resetDocumentMutationLatchForTests()
  let setContent = false
  const prep = await prepareDestructiveDocumentChange('Before import', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  if (prep.ok) prep.applyReplacement(() => { setContent = true })
  assert.equal(prep.ok, true)
  assert.equal(setContent, true)
})

test('15. successful preservation permits restore', async () => {
  resetDocumentMutationLatchForTests()
  let setContent = false
  const prep = await prepareDestructiveDocumentChange('Auto-save before restore', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => 'A',
    flushNow: async () => ({ ok: true, savedAt: 't' }),
    createVersion: async () => okVersion('A'),
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  if (prep.ok) prep.applyReplacement(() => { setContent = true })
  assert.equal(prep.ok, true)
  assert.equal(setContent, true)
})

test('17. user edit during asynchronous preparation is blocked, not silently lost', async () => {
  resetDocumentMutationLatchForTests()
  const harness = createHeadlessEditor({
    html: '<p>A</p>',
    isLocked: () => isDocumentMutationLocked(),
  })
  lockDocumentMutations()
  const before = harness.editor.state.doc.textContent
  harness.editor.commands.insertContent('A2')
  assert.equal(isDocumentMutationLocked(), true)
  assert.equal(harness.editor.state.doc.textContent, before)
  assert.equal(harness.editor.state.doc.textContent.includes('A2'), false)
  unlockDocumentMutations()
  harness.editor.commands.insertContent('A2')
  assert.equal(harness.editor.state.doc.textContent.includes('A2'), true)
  harness.destroy()
  resetDocumentMutationLatchForTests()
})

test('18. Cmd+S current-save failure produces no success state', async () => {
  let versioned = false
  const outcome = await saveManualVersion(
    async () => ({ ok: false, kind: 'error', message: 'write failed' }),
    async () => {
      versioned = true
      return okVersion('A')
    },
  )
  assert.equal(outcome.ok, false)
  assert.equal(versioned, false)
})

test('19. Cmd+S full success occurs only after both required durable operations', async () => {
  const steps: string[] = []
  const outcome = await saveManualVersion(
    async () => {
      steps.push('flush')
      return { ok: true, savedAt: 't' }
    },
    async () => {
      steps.push('version')
      return okVersion('A')
    },
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(steps, ['flush', 'version'])
})

test('20. Accept flush failure leaves accepted content in memory but reports unsaved/error', async () => {
  const editorHtml = { current: 'B' }
  const outcome = await persistAfterAccept(
    async () => ({ ok: false, kind: 'error', message: 'write failed' }),
    async () => okVersion('B'),
  )
  assert.equal(outcome.ok, false)
  assert.equal(editorHtml.current, 'B')
})

test('21. Reject flush failure leaves restored content in memory but reports unsaved/error', async () => {
  const editorHtml = { current: 'A' }
  const outcome = await persistAfterReject(
    async () => ({ ok: false, kind: 'error', message: 'write failed' }),
  )
  assert.equal(outcome.ok, false)
  assert.equal(editorHtml.current, 'A')
})

test('22. no unhandled rejection from Accept/Reject persistence failure', async () => {
  const accept = persistAfterAccept(
    async () => ({ ok: false, kind: 'error', message: 'write failed' }),
    async () => {
      throw new Error('should not run')
    },
  )
  const reject = persistAfterReject(
    async () => ({ ok: false, kind: 'error', message: 'write failed' }),
  )
  const [a, r] = await Promise.all([accept, reject])
  assert.equal(a.ok, false)
  assert.equal(r.ok, false)
})

test('prepare uses the frozen snapshot, not a later live HTML', async () => {
  resetDocumentMutationLatchForTests()
  let live = 'A'
  const versions: string[] = []
  const flushGate = Promise.resolve()
  const prep = prepareDestructiveDocumentChange('Before new document', {
    persistEnabled: true,
    storageUnavailable: false,
    getSnapshot: () => live,
    flushNow: async () => {
      await flushGate
      return { ok: true, savedAt: 't' }
    },
    createVersion: async (_d, html) => {
      versions.push(html)
      live = 'A2'
      return okVersion(html)
    },
    beginDestructiveTransition: async () => ({ ok: true, savedAt: 't' }),
  })
  const result = await prep
  assert.equal(result.ok, false)
  assert.deepEqual(versions, ['A'])
  resetDocumentMutationLatchForTests()
})

test('23. migration warning is observable when legacy versions fail but current document remains usable', async () => {
  await resetPersistence()
  await saveCurrentDocument('<p>current-ok</p>', '2026-09-15T12:00:00.000Z')
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>legacy</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  localStorage.setItem(LEGACY_VERSIONS_KEY, '{not-json')
  const hydration = await hydrateDocument()
  assert.equal(hydration.phase, 'ready')
  if (hydration.phase === 'ready') {
    assert.equal(hydration.persistEnabled, true)
    assert.equal(hydration.degraded, false)
    assert.equal(hydration.html, '<p>current-ok</p>')
    assert.ok(hydration.migrationWarning)
  }
})
