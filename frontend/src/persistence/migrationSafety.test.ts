import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getDocumentDb } from './db.ts'
import { loadCurrentDocument, saveCurrentDocument } from './documentStore.ts'
import { DEFAULT_DOCUMENT_HTML, hydrateDocument, resolveInitialHtml } from './hydrate.ts'
import { migrateLegacyPersistence } from './migrate.ts'
import { resetPersistence } from './testUtils.ts'
import {
  LEGACY_DOCUMENT_KEY,
  LEGACY_VERSIONS_KEY,
  MAX_VERSIONS,
  type HydrationResult,
  type VersionRecord,
} from './types.ts'
import { countVersions, createVersion, listVersions } from './versionStore.ts'

test('different browser document survives failed migration', async () => {
  await resetPersistence()
  const browserHtml = '<p>document-B</p>'
  const legacyRaw = JSON.stringify({ html: '<p>document-A</p>', savedAt: '2026-01-01T00:00:00.000Z' })
  await saveCurrentDocument(browserHtml, '2026-09-15T12:00:00.000Z')
  localStorage.setItem(LEGACY_DOCUMENT_KEY, legacyRaw)
  localStorage.setItem(LEGACY_VERSIONS_KEY, '{not-json')

  const first = await migrateLegacyPersistence()
  assert.equal(first.status, 'skipped')
  if (first.status === 'skipped') assert.ok(first.versionWarning)

  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), legacyRaw)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), '{not-json')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, browserHtml)

  const retry = await migrateLegacyPersistence()
  assert.equal(retry.status, 'skipped')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), legacyRaw)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), '{not-json')
})

test('failed version migration keeps the old record and does not mark migration complete', async () => {
  await resetPersistence()
  const html = '<p>current-ok</p>'
  await saveCurrentDocument(html, '2026-09-15T12:00:00.000Z')
  const versionsRaw = '{not-json'
  localStorage.setItem(LEGACY_VERSIONS_KEY, versionsRaw)

  const result = await migrateLegacyPersistence()
  assert.equal(result.status, 'skipped')
  if (result.status === 'skipped') assert.ok(result.versionWarning)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), versionsRaw)

  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, html)
  assert.equal(await countVersions(), 0)
})

test('retry after failed migration succeeds', async () => {
  await resetPersistence()
  const html = '<p>legacy retry</p>'
  const legacyRaw = JSON.stringify({ html, savedAt: '2026-01-01T00:00:00.000Z' })
  localStorage.setItem(LEGACY_DOCUMENT_KEY, legacyRaw)

  const factory = globalThis.indexedDB
  const { closeDocumentDb } = await import('./db.ts')
  await closeDocumentDb()
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
  try {
    const failed = await migrateLegacyPersistence()
    assert.equal(failed.status, 'failed')
    assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), legacyRaw)
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true })
  }

  const second = await migrateLegacyPersistence()
  assert.equal(second.status, 'migrated')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), null)
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, html)
})

test('corrupted record does not delete valid data', async () => {
  await resetPersistence()

  localStorage.setItem(LEGACY_DOCUMENT_KEY, '{not-json')
  assert.equal((await migrateLegacyPersistence()).status, 'failed')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), '{not-json')

  localStorage.setItem(LEGACY_DOCUMENT_KEY, JSON.stringify({ savedAt: '2026-01-01T00:00:00.000Z' }))
  assert.equal((await migrateLegacyPersistence()).status, 'failed')
  assert.equal(
    localStorage.getItem(LEGACY_DOCUMENT_KEY),
    JSON.stringify({ savedAt: '2026-01-01T00:00:00.000Z' }),
  )

  await resetPersistence()
  const db = await getDocumentDb()
  const malformed = { id: 'current', schemaVersion: 1, html: 12, savedAt: 'nope' }
  await db.put('documents', malformed as never)
  assert.equal((await loadCurrentDocument()).status, 'malformed')
  const blocked = await hydrateDocument()
  assert.equal(blocked.phase, 'blocked')
  assert.equal((await loadCurrentDocument()).status, 'malformed')
  const stillThere = await db.get('documents', 'current')
  assert.deepEqual(stillThere, malformed)

  await resetPersistence()
  await saveCurrentDocument('<p>ok</p>', '2026-09-15T12:00:00.000Z')
  const allInvalid = JSON.stringify([
    { id: 'bad', timestamp: 'not-a-date', description: 1, content: null },
    { nope: true },
  ])
  localStorage.setItem(LEGACY_VERSIONS_KEY, allInvalid)
  await migrateLegacyPersistence()
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), allInvalid)

  await resetPersistence()
  for (let i = 0; i < MAX_VERSIONS; i++) {
    await createVersion({
      id: `keep-${i}`,
      timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      description: `keep-${i}`,
      content: `<p>${i}</p>`,
    })
  }
  const versionDb = await getDocumentDb()
  await versionDb.put('versions', {
    id: 'ghost',
    timestamp: 'not-iso',
    description: 'ghost',
    content: '<p>ghost</p>',
  } as never)
  // Pre-fix: count included the ghost, so creating one more pruned two valid rows
  // while leaving the ghost. Post-fix: ghost is swept, only the oldest valid is pruned.
  await createVersion({
    id: 'newest',
    timestamp: '2026-02-01T00:00:00.000Z',
    description: 'newest',
    content: '<p>newest</p>',
  })
  const listed = await listVersions()
  assert.equal(listed.length, MAX_VERSIONS)
  assert.equal(listed.some(item => item.id === 'keep-0'), false)
  assert.equal(listed.some(item => item.id === 'keep-1'), true)
  assert.equal(listed.some(item => item.id === 'newest'), true)
  assert.equal(listed.some(item => item.id === 'ghost'), false)
  assert.equal(await countVersions(), MAX_VERSIONS)
})

test('explicit user reset is required for broken durable records', async () => {
  await resetPersistence()
  const db = await getDocumentDb()
  const malformed = { id: 'current', schemaVersion: 1, html: 12, savedAt: 'nope' }
  await db.put('documents', malformed as never)

  const hydration = await hydrateDocument()
  assert.equal(hydration.phase, 'blocked')
  assert.equal(hydration.persistEnabled, false)
  assert.equal(resolveInitialHtml(hydration), null)
  assert.equal((await loadCurrentDocument()).status, 'malformed')
  assert.deepEqual(await db.get('documents', 'current'), malformed)

  // startNewDocumentFromBlocked only flips UI state; it does not clear IDB.
  const afterExplicitReset: HydrationResult = {
    phase: 'ready',
    html: null,
    savedAt: null,
    persistEnabled: true,
    degraded: false,
    message: null,
  }
  assert.equal(resolveInitialHtml(afterExplicitReset), DEFAULT_DOCUMENT_HTML)
  assert.equal((await loadCurrentDocument()).status, 'malformed')
  assert.deepEqual(await db.get('documents', 'current'), malformed)

  await saveCurrentDocument(DEFAULT_DOCUMENT_HTML, '2026-09-25T00:00:00.000Z')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.html, DEFAULT_DOCUMENT_HTML)
})

test('corrupt legacy with empty IDB hydrates blocked without writing a default document', async () => {
  await resetPersistence()
  const legacyRaw = '{not-json'
  localStorage.setItem(LEGACY_DOCUMENT_KEY, legacyRaw)

  const hydration = await hydrateDocument()
  assert.equal(hydration.phase, 'blocked')
  assert.equal(hydration.persistEnabled, false)
  assert.equal(hydration.html, null)
  assert.equal(resolveInitialHtml(hydration), null)
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), legacyRaw)
  assert.equal((await loadCurrentDocument()).status, 'missing')
})

test('non-empty raw versions that parse to empty are not removed', async () => {
  await resetPersistence()
  await saveCurrentDocument('<p>ok</p>', '2026-09-15T12:00:00.000Z')
  const raw = JSON.stringify([
    { id: '', timestamp: 'bad', description: 1, content: null },
    { id: 'x' },
  ])
  localStorage.setItem(LEGACY_VERSIONS_KEY, raw)

  const result = await migrateLegacyPersistence()
  assert.equal(result.status, 'skipped')
  if (result.status === 'skipped') assert.ok(result.versionWarning)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), raw)
  assert.equal(await countVersions(), 0)

  await resetPersistence()
  localStorage.setItem(
    LEGACY_DOCUMENT_KEY,
    JSON.stringify({ html: '<p>doc</p>', savedAt: '2026-01-01T00:00:00.000Z' }),
  )
  localStorage.setItem(LEGACY_VERSIONS_KEY, raw)
  const migrated = await migrateLegacyPersistence()
  assert.equal(migrated.status, 'migrated')
  assert.equal(localStorage.getItem(LEGACY_DOCUMENT_KEY), null)
  assert.equal(localStorage.getItem(LEGACY_VERSIONS_KEY), raw)
})

test('createVersion rejects unparseable input before put and removes failed writes', async () => {
  await resetPersistence()
  await assert.rejects(
    () => createVersion({
      id: 'bad',
      timestamp: 'not-iso',
      description: 'bad',
      content: '<p>bad</p>',
    } as VersionRecord),
  )
  assert.equal(await countVersions(), 0)
  assert.deepEqual(await listVersions(), [])
})
