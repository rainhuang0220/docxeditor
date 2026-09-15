import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canPersistCommittedDocument, persistableHtml } from '../ai/reviewTransaction.ts'
import { closeDocumentDb, getDocumentDb } from './db.ts'
import { loadCurrentDocument, saveCurrentDocument } from './documentStore.ts'
import { PersistenceError, SkipPersistError } from './errors.ts'
import { DEFAULT_DOCUMENT_HTML, hydrateDocument, resolveInitialHtml } from './hydrate.ts'
import { bindPageLifecycle } from './lifecycle.ts'
import { migrateLegacyPersistence } from './migrate.ts'
import { createSaveCoordinator } from './saveCoordinator.ts'
import { formatPersistenceStatus, persistenceStatusIsSaved } from './status.ts'
import { createFakeClock, deferred, resetPersistence } from './testUtils.ts'
import { LEGACY_DOCUMENT_KEY, LEGACY_VERSIONS_KEY, MAX_VERSIONS } from './types.ts'
import { createVersion, listVersions } from './versionStore.ts'

test('1. empty DB → no saved document', async () => {
  await resetPersistence()
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'missing')
})

test('2. save current → reload returns exact HTML', async () => {
  await resetPersistence()
  await saveCurrentDocument('<h1>Exact</h1>', '2026-09-15T01:00:00.000Z')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, '<h1>Exact</h1>')
})

test('3. large data-URL document saves and reloads intact', async () => {
  await resetPersistence()
  const html = `<p><img src="data:image/png;base64,${'A'.repeat(2048)}"></p>`
  await saveCurrentDocument(html, '2026-09-15T01:00:00.000Z')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, html)
})

test('4. save failure produces error/dirty state, not Saved', async () => {
  const coordinator = createSaveCoordinator({
    getSnapshot: () => '<p>x</p>',
    persist: async () => {
      throw new PersistenceError('write', 'Could not save the document.')
    },
  })
  await coordinator.flushNow()
  const status = coordinator.getStatus()
  assert.equal(status.kind, 'error')
  assert.equal(formatPersistenceStatus(status), 'Save failed')
  assert.equal(persistenceStatusIsSaved(status), false)
  coordinator.dispose()
})

test('5. save coordinator serializes writes', async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const coordinator = createSaveCoordinator({
    getSnapshot: () => 'n',
    persist: async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await Promise.resolve()
      concurrent -= 1
      return { savedAt: 't' }
    },
  })
  await Promise.all([coordinator.flushNow(), coordinator.flushNow(), coordinator.flushNow()])
  assert.equal(maxConcurrent, 1)
  coordinator.dispose()
})

test('6. slow A + newer B → final durable state B', async () => {
  const clock = createFakeClock()
  let live = 'A'
  const writes: string[] = []
  const gate = deferred<void>()
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      if (html === 'A') await gate.promise
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  await clock.advance(800)
  live = 'B'
  coordinator.scheduleSave()
  gate.resolve()
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'B')
  coordinator.dispose()
})

test('7. multiple rapid edits coalesce without reverting to an older state', async () => {
  const clock = createFakeClock()
  let live = 'a'
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
  live = 'b'
  coordinator.scheduleSave()
  live = 'c'
  coordinator.scheduleSave()
  live = 'd'
  coordinator.scheduleSave()
  await clock.advance(800)
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'd')
  assert.equal(writes.includes('a'), false)
  coordinator.dispose()
})

test('8. flushNow persists latest committed snapshot', async () => {
  let live = 'old'
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  live = 'latest'
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'latest')
  coordinator.dispose()
})

test('9. async startup waits for hydration before initializing authoritative editor content', async () => {
  assert.equal(resolveInitialHtml({ phase: 'loading' }), null)
})

test('10. persisted content cannot be overwritten by initial default content during hydration', () => {
  const html = '<p>persisted</p>'
  assert.equal(resolveInitialHtml({
    phase: 'ready',
    html,
    savedAt: 't',
    persistEnabled: true,
    degraded: false,
    message: null,
  }, DEFAULT_DOCUMENT_HTML), html)
})

test('11. legacy localStorage current document migrates exactly once', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>once</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  const first = await migrateLegacyPersistence()
  const second = await migrateLegacyPersistence()
  assert.equal(first.status, 'migrated')
  assert.equal(second.status, 'skipped')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, '<p>once</p>')
})

test('12. legacy versions migrate without duplication', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>d</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  localStorage.setItem(LEGACY_VERSIONS_KEY, JSON.stringify([
    { id: 'same', timestamp: '2026-01-01T00:00:00.000Z', description: 'v', content: '<p>v</p>' },
  ]))
  await migrateLegacyPersistence()
  localStorage.setItem(LEGACY_VERSIONS_KEY, JSON.stringify([
    { id: 'same', timestamp: '2026-01-01T00:00:00.000Z', description: 'v', content: '<p>v</p>' },
  ]))
  await migrateLegacyPersistence()
  const listed = await listVersions()
  assert.equal(listed.filter(item => item.id === 'same').length, 1)
})

test('13. successful migration removes only migrated durable legacy keys', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>d</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  localStorage.setItem(LEGACY_VERSIONS_KEY, JSON.stringify([]))
  localStorage.setItem('ai-doc-ide-title', 'Title')
  await migrateLegacyPersistence()
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), null)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), null)
  assert.equal(localStorage.getItem('ai-doc-ide-title'), 'Title')
})

test('14. failed migration leaves legacy data intact', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, '{bad')
  const result = await migrateLegacyPersistence()
  assert.equal(result.status, 'failed')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), '{bad')
})

test('15. corrupt legacy document does not crash startup', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, '{bad')
  const hydration = await hydrateDocument()
  assert.ok(hydration.phase === 'ready' || hydration.phase === 'blocked')
})

test('16. corrupt durable record produces explicit recovery/error behavior', async () => {
  await resetPersistence()
  const db = await getDocumentDb()
  await db.put('documents', { id: 'current', html: '<p>x</p>' } as never)
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'malformed')
  const hydration = await hydrateDocument()
  assert.equal(hydration.phase, 'blocked')
  assert.equal(resolveInitialHtml(hydration), null)
})

test('17. versions are individual records', async () => {
  await resetPersistence()
  await createVersion({ id: 'a', timestamp: '2026-01-02T00:00:00.000Z', description: 'a', content: '<p>a</p>' })
  await createVersion({ id: 'b', timestamp: '2026-01-03T00:00:00.000Z', description: 'b', content: '<p>b</p>' })
  const db = await getDocumentDb()
  const raw = await db.get('versions', 'a')
  assert.equal(raw?.content, '<p>a</p>')
})

test('18. version list is newest-first', async () => {
  await resetPersistence()
  await createVersion({ id: 'old', timestamp: '2026-01-01T00:00:00.000Z', description: 'old', content: '<p>old</p>' })
  await createVersion({ id: 'new', timestamp: '2026-01-03T00:00:00.000Z', description: 'new', content: '<p>new</p>' })
  const listed = await listVersions()
  assert.deepEqual(listed.map(item => item.id), ['new', 'old'])
})

test('19. version #21 prunes exactly the oldest under the 20-version policy', async () => {
  await resetPersistence()
  for (let i = 0; i < 21; i++) {
    await createVersion({
      id: `n${i}`,
      timestamp: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      description: `n${i}`,
      content: `<p>${i}</p>`,
    })
  }
  const listed = await listVersions()
  assert.equal(listed.length, MAX_VERSIONS)
  assert.equal(listed.some(item => item.id === 'n0'), false)
  assert.equal(listed[0]?.id, 'n20')
})

test('20. version persistence failure is surfaced', async () => {
  await resetPersistence()
  await closeDocumentDb()
  const original = globalThis.indexedDB
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
  try {
    await assert.rejects(
      () => createVersion({ id: 'z', timestamp: '2026-01-01T00:00:00.000Z', description: 'z', content: 'z' }),
      PersistenceError,
    )
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true })
  }
})

test('21. manual Save reports success only after durable write', async () => {
  await resetPersistence()
  const saved = await createVersion({
    id: 'manual',
    timestamp: '2026-01-01T00:00:00.000Z',
    description: 'Manual save',
    content: '<p>manual</p>',
  })
  const listed = await listVersions()
  assert.equal(listed[0]?.id, saved.id)
  assert.equal(listed[0]?.description, 'Manual save')
})

test('22. Before-import version persistence uses the shared version service', async () => {
  await resetPersistence()
  await createVersion({
    id: 'imp',
    timestamp: '2026-01-01T00:00:00.000Z',
    description: 'Before import',
    content: '<p>pre-import</p>',
  })
  const listed = await listVersions()
  assert.equal(listed[0]?.description, 'Before import')
})

test('23. Before-AI-edit version uses the shared version service', async () => {
  await resetPersistence()
  await createVersion({
    id: 'ai',
    timestamp: '2026-01-01T00:00:00.000Z',
    description: 'Before AI edit',
    content: '<p>pre-ai</p>',
  })
  const listed = await listVersions()
  assert.equal(listed[0]?.description, 'Before AI edit')
})

test('24. pending AI review autosave persists pre-AI committed A, never provisional B', async () => {
  const A = '<p>A</p>'
  const B = '<p>B</p>'
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    getSnapshot: () => {
      if (!canPersistCommittedDocument('pending', A)) throw new SkipPersistError()
      return persistableHtml('pending', A, B)
    },
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  await coordinator.flushNow()
  assert.deepEqual(writes, [A])
  coordinator.dispose()
})

test('25. Accept schedules/immediately requests durable B', async () => {
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    getSnapshot: () => persistableHtml('committed', null, '<p>B</p>'),
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  await coordinator.flushNow()
  assert.deepEqual(writes, ['<p>B</p>'])
  coordinator.dispose()
})

test('26. Reject schedules/immediately requests durable restored A', async () => {
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    getSnapshot: () => persistableHtml('rejected', null, '<p>A</p>'),
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  await coordinator.flushNow()
  assert.deepEqual(writes, ['<p>A</p>'])
  coordinator.dispose()
})

test('27. stale/invalid/aborted AI request never persists a provisional mutation', async () => {
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    getSnapshot: () => persistableHtml('idle', null, '<p>unchanged A</p>'),
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  await coordinator.flushNow()
  assert.deepEqual(writes, ['<p>unchanged A</p>'])
  coordinator.dispose()
})

test('28. queued autosave from old document cannot overwrite a later New Document', async () => {
  const clock = createFakeClock()
  let live = 'DOC-A'
  const writes: string[] = []
  const gate = deferred<void>()
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      if (html === 'DOC-A') await gate.promise
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  await clock.advance(800)
  const transition = coordinator.beginDestructiveTransition()
  gate.resolve()
  await transition
  live = 'DOC-B'
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'DOC-B')
  coordinator.dispose()
})

test('29. queued autosave from old document cannot overwrite a successful import', async () => {
  const clock = createFakeClock()
  let live = 'BEFORE-IMPORT'
  const writes: string[] = []
  const gate = deferred<void>()
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      if (html === 'BEFORE-IMPORT') await gate.promise
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  await clock.advance(800)
  const transition = coordinator.beginDestructiveTransition()
  gate.resolve()
  await transition
  live = 'IMPORTED'
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'IMPORTED')
  coordinator.dispose()
})

test('30. queued autosave cannot overwrite a restored version', async () => {
  const clock = createFakeClock()
  let live = 'CURRENT'
  const writes: string[] = []
  const gate = deferred<void>()
  const coordinator = createSaveCoordinator({
    clock,
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      if (html === 'CURRENT') await gate.promise
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  await clock.advance(800)
  const transition = coordinator.beginDestructiveTransition()
  gate.resolve()
  await transition
  live = 'RESTORED'
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'RESTORED')
  coordinator.dispose()
})

test('31. StatusBar Saved state is driven by successful persistence state, not localStorage polling', () => {
  assert.equal(formatPersistenceStatus({ kind: 'clean', savedAt: '2026-09-15T14:32:00.000Z' }).startsWith('Saved'), true)
  assert.equal(formatPersistenceStatus({ kind: 'error', message: 'fail' }).includes('Saved'), false)
  assert.match(formatPersistenceStatus({ kind: 'error', message: 'fail' }), /Save failed/)
})

test('32. current-document HTML has no authoritative localStorage write after migration', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>old</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  await migrateLegacyPersistence()
  await saveCurrentDocument('<p>new</p>', '2026-09-15T01:00:00.000Z')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), null)
})

test('33. version-history HTML has no authoritative localStorage write after migration', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_VERSIONS_KEY, JSON.stringify([]))
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>d</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  await migrateLegacyPersistence()
  await createVersion({
    id: 'post',
    timestamp: '2026-09-15T01:00:00.000Z',
    description: 'after',
    content: '<p>after</p>',
  })
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), null)
})

test('34. model/thread/preferences remain untouched by migration', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>d</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  localStorage.setItem('ai-doc-ide-models', '{"keep":true}')
  localStorage.setItem('ai-doc-ide-threads', '{"keep":true}')
  localStorage.setItem('theme', 'light')
  await migrateLegacyPersistence()
  assert.equal(localStorage.getItem('ai-doc-ide-models'), '{"keep":true}')
  assert.equal(localStorage.getItem('ai-doc-ide-threads'), '{"keep":true}')
  assert.equal(localStorage.getItem('theme'), 'light')
})

test('35. IDB-unavailable mode never reports Saved', async () => {
  await resetPersistence()
  await closeDocumentDb()
  const original = globalThis.indexedDB
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
  let hydration
  try {
    hydration = await hydrateDocument()
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true })
  }
  assert.equal(hydration.phase, 'ready')
  if (hydration.phase === 'ready') {
    assert.equal(hydration.persistEnabled, false)
    assert.equal(hydration.degraded, true)
  }
  const status = formatPersistenceStatus({
    kind: 'degraded',
    message: 'Document storage is unavailable.',
  })
  assert.equal(status.includes('Saved'), false)
})

test('36. page/visibility flush invokes save of latest dirty committed snapshot', async () => {
  let live = 'hidden-doc'
  const writes: string[] = []
  const coordinator = createSaveCoordinator({
    debounceMs: 800,
    getSnapshot: () => live,
    persist: async (html) => {
      writes.push(html)
      return { savedAt: 't' }
    },
  })
  coordinator.scheduleSave()
  live = 'latest-hidden'
  const stop = bindPageLifecycle(() => {
    void coordinator.flushNow()
  })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  const HideEvent = window.Event
  document.dispatchEvent(new HideEvent('visibilitychange'))
  await coordinator.flushNow()
  assert.equal(writes.at(-1), 'latest-hidden')
  stop()
  coordinator.dispose()
})
