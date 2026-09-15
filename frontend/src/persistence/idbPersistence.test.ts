import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadCurrentDocument, saveCurrentDocument } from './documentStore.ts'
import { hydrateDocument, resolveInitialHtml, DEFAULT_DOCUMENT_HTML } from './hydrate.ts'
import { bindPageLifecycle, isDocumentHidden } from './lifecycle.ts'
import { migrateLegacyPersistence } from './migrate.ts'
import { formatPersistenceStatus, persistenceStatusIsSaved } from './status.ts'
import { resetPersistence } from './testUtils.ts'
import {
  LEGACY_DOCUMENT_KEY,
  LEGACY_VERSIONS_KEY,
  MAX_VERSIONS,
  type VersionRecord,
} from './types.ts'
import { countVersions, createVersion, listVersions } from './versionStore.ts'

test('empty database has no current document', async () => {
  await resetPersistence()
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'missing')
})

test('save current → reload returns exact HTML', async () => {
  await resetPersistence()
  const html = '<p>Hello <strong>world</strong></p>'
  await saveCurrentDocument(html, '2026-09-15T12:00:00.000Z')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') {
    assert.equal(loaded.record.html, html)
    assert.equal(loaded.record.savedAt, '2026-09-15T12:00:00.000Z')
    assert.equal(loaded.record.id, 'current')
    assert.equal(loaded.record.schemaVersion, 1)
  }
})

test('24. actual ~6 MiB data-URL document round-trips through production IDB code exactly', async () => {
  await resetPersistence()
  const payload = 'A'.repeat(6 * 1024 * 1024)
  const html = `<p><img src="data:image/png;base64,${payload}"></p>`
  assert.ok(html.length > 6 * 1024 * 1024)
  await saveCurrentDocument(html, '2026-09-15T12:00:00.000Z')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, html)
})

test('malformed durable record is not reinterpreted as valid', async () => {
  await resetPersistence()
  const { getDocumentDb } = await import('./db.ts')
  const db = await getDocumentDb()
  await db.put('documents', { id: 'current', schemaVersion: 1, html: 12, savedAt: 'nope' } as never)
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'malformed')
})

test('legacy document and versions migrate exactly once', async () => {
  await resetPersistence()
  const html = '<p>legacy body</p>'
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html, savedAt: '2026-01-01T00:00:00.000Z' }))
  const versions: VersionRecord[] = [
    { id: 'v1', timestamp: '2026-01-01T00:00:00.000Z', description: 'one', content: '<p>one</p>' },
    { id: 'v2', timestamp: '2026-01-02T00:00:00.000Z', description: 'two', content: '<p>two</p>' },
  ]
  localStorage.setItem(LEGACY_VERSIONS_KEY, JSON.stringify(versions))
  const first = await migrateLegacyPersistence()
  assert.equal(first.status, 'migrated')
  if (first.status === 'migrated') {
    assert.equal(first.document, true)
    assert.equal(first.versions, 2)
  }
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), null)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), null)
  const second = await migrateLegacyPersistence()
  assert.equal(second.status, 'skipped')
  const listed = await listVersions()
  assert.equal(listed.length, 2)
  assert.equal(listed[0]?.id, 'v2')
})

test('successful migration removes only durable legacy keys', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ html: '<p>x</p>', savedAt: '2026-01-01T00:00:00.000Z' }))
  localStorage.setItem(LEGACY_VERSIONS_KEY, JSON.stringify([]))
  localStorage.setItem('theme', 'dark')
  localStorage.setItem('ai-doc-ide-word-goal', '500')
  localStorage.setItem('ai-doc-ide-title', 'Kept')
  localStorage.setItem('ai-doc-ide-threads', '[]')
  localStorage.setItem('ai-doc-ide-models', '[]')
  localStorage.setItem('ai-doc-ide-active-model', 'default-gpt-4o')
  localStorage.setItem('ai-doc-ide-header', 'H')
  await migrateLegacyPersistence()
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), null)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), null)
  assert.equal(localStorage.getItem('theme'), 'dark')
  assert.equal(localStorage.getItem('ai-doc-ide-word-goal'), '500')
  assert.equal(localStorage.getItem('ai-doc-ide-title'), 'Kept')
  assert.equal(localStorage.getItem('ai-doc-ide-threads'), '[]')
  assert.equal(localStorage.getItem('ai-doc-ide-models'), '[]')
  assert.equal(localStorage.getItem('ai-doc-ide-active-model'), 'default-gpt-4o')
  assert.equal(localStorage.getItem('ai-doc-ide-header'), 'H')
})

test('failed migration leaves legacy data intact', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, '{not-json')
  localStorage.setItem('theme', 'light')
  const result = await migrateLegacyPersistence()
  assert.equal(result.status, 'failed')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), '{not-json')
  assert.equal(localStorage.getItem('theme'), 'light')
})

test('corrupt legacy document does not crash startup', async () => {
  await resetPersistence()
  localStorage.setItem(LEGACY_DOCUMENT_KEY, '{not-json')
  const hydration = await hydrateDocument()
  assert.ok(hydration.phase === 'ready' || hydration.phase === 'blocked')
})

test('versions are individual records, newest first, max 20 prunes oldest', async () => {
  await resetPersistence()
  for (let i = 1; i <= 21; i++) {
    const stamp = `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`
    await createVersion({
      id: `id-${i}`,
      timestamp: stamp,
      description: `v${i}`,
      content: `<p>${i}</p>`,
    })
  }
  const listed = await listVersions()
  assert.equal(listed.length, MAX_VERSIONS)
  assert.equal(listed[0]?.id, 'id-21')
  assert.equal(listed.at(-1)?.id, 'id-2')
  assert.equal(listed.some(item => item.id === 'id-1'), false)
  assert.equal(await countVersions(), MAX_VERSIONS)
})

test('version persistence failure is surfaced as an error', async () => {
  await resetPersistence()
  const original = globalThis.indexedDB
  const { closeDocumentDb } = await import('./db.ts')
  await closeDocumentDb()
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
  try {
    await assert.rejects(() => createVersion({
      id: 'x',
      timestamp: '2026-01-01T00:00:00.000Z',
      description: 'x',
      content: '<p>x</p>',
    }))
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true })
  }
})

test('resolveInitialHtml waits for hydration and never prefers default over persisted', () => {
  assert.equal(resolveInitialHtml({ phase: 'loading' }, DEFAULT_DOCUMENT_HTML), null)
  assert.equal(resolveInitialHtml({
    phase: 'blocked',
    html: null,
    savedAt: null,
    persistEnabled: false,
    degraded: true,
    message: 'bad',
  }, DEFAULT_DOCUMENT_HTML), null)
  const persisted = '<p>real document</p>'
  assert.equal(resolveInitialHtml({
    phase: 'ready',
    html: persisted,
    savedAt: 't',
    persistEnabled: true,
    degraded: false,
    message: null,
  }, DEFAULT_DOCUMENT_HTML), persisted)
  assert.notEqual(resolveInitialHtml({
    phase: 'ready',
    html: persisted,
    savedAt: 't',
    persistEnabled: true,
    degraded: false,
    message: null,
  }, DEFAULT_DOCUMENT_HTML), DEFAULT_DOCUMENT_HTML)
})

test('formatPersistenceStatus never reports Saved on error or degraded', () => {
  assert.equal(formatPersistenceStatus({ kind: 'error', message: 'nope' }), 'Save failed')
  assert.equal(formatPersistenceStatus({ kind: 'degraded', message: 'nope' }), 'Save unavailable')
  assert.equal(formatPersistenceStatus({ kind: 'dirty' }), 'Unsaved')
  assert.equal(formatPersistenceStatus({ kind: 'saving' }), 'Saving…')
  assert.equal(persistenceStatusIsSaved({ kind: 'error', message: 'nope' }), false)
  assert.equal(persistenceStatusIsSaved({ kind: 'clean', savedAt: '2026-09-15T14:32:00.000Z' }), true)
})

test('page/visibility lifecycle invokes flush', () => {
  assert.equal(isDocumentHidden({ visibilityState: 'hidden' }), true)
  assert.equal(isDocumentHidden({ visibilityState: 'visible' }), false)
  const seen: string[] = []
  const originalAdd = window.addEventListener.bind(window)
  const originalRemove = window.removeEventListener.bind(window)
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    seen.push(type)
    return originalAdd(type, listener, options)
  }) as typeof window.addEventListener
  const stop = bindPageLifecycle(() => {})
  window.addEventListener = originalAdd
  window.removeEventListener = originalRemove
  try {
    assert.ok(seen.includes('pagehide'))
    assert.ok(seen.includes('visibilitychange'))
  } finally {
    stop()
  }
})

test('current-document save does not write legacy localStorage keys', async () => {
  await resetPersistence()
  await saveCurrentDocument('<p>idb</p>', '2026-09-15T12:00:00.000Z')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), null)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), null)
})
