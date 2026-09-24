import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildChatRequest } from '../utils/chatRequest.ts'
import { credentialStatusLine, transferLegacyCredential } from '../utils/credentials.ts'
import { draftFromStatus, reduceCredentialDraft } from '../utils/credentialEditor.ts'
import { migrateLegacyModelSecrets, writeProfilesPreservingRetainedSecrets } from '../utils/legacyModelMigration.ts'
import { closeDocumentDb, deleteDocumentDb, getDocumentDb } from './db.ts'
import {
  MODELS_KEY,
  loadModelProfiles,
  saveModelProfiles,
  type ModelProfile,
} from '../utils/storage.ts'

const SENTINEL = 'DOCXEDITOR_SECRET_SENTINEL_9f2c'

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-a',
    label: 'GPT',
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://example.invalid/v1',
    ...overrides,
  }
}

function storageBlob(): string {
  return Object.values(localStorage).join('\n') + JSON.stringify(localStorage)
}

test('canonical profile load drops apiKey and save allowlists fields', () => {
  localStorage.clear()
  localStorage.setItem(MODELS_KEY, JSON.stringify([{
    ...profile(),
    apiKey: SENTINEL,
    keyHint: 'DOCXEDI…',
  }]))
  const loaded = loadModelProfiles()
  assert.equal(loaded.length, 1)
  assert.deepEqual(Object.keys(loaded[0]).sort(), ['baseUrl', 'id', 'label', 'model', 'provider'])
  assert.equal(JSON.stringify(loaded).includes(SENTINEL), false)

  localStorage.clear()
  saveModelProfiles([{ ...profile(), apiKey: SENTINEL } as ModelProfile])
  const saved = localStorage.getItem(MODELS_KEY) || ''
  assert.equal(saved.includes(SENTINEL), false)
  assert.equal(saved.includes('apiKey'), false)
  assert.equal(saved.includes('keyHint'), false)
  assert.equal(storageBlob().includes(SENTINEL), false)
})

test('legacy key migrates only after a durable verified transfer', async () => {
  localStorage.clear()
  const original = {
    ...profile(),
    label: 'Work',
    apiKey: SENTINEL,
    keyHint: 'DOCXEDI…',
    note: 'keep-me',
  }
  localStorage.setItem(MODELS_KEY, JSON.stringify([original, {
    id: 'profile-b',
    label: 'Claude',
    provider: 'anthropic',
    model: 'claude',
    baseUrl: '',
    apiKey: 'second-secret-value',
  }]))
  const calls: string[] = []
  const logs: string[] = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    const first = await migrateLegacyModelSecrets(async input => {
      calls.push(input.id)
      assert.equal(logs.join('\n').includes(SENTINEL), false)
      if (input.id === 'profile-b') return { durable: false, accepted: false, sessionOnly: false }
      return { durable: true, accepted: true, sessionOnly: false }
    })
    assert.deepEqual(first.scrubbedIds, ['profile-a'])
    assert.deepEqual(first.retainedIds, ['profile-b'])
    const stored = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')
    const kept = stored.find((item: { id: string }) => item.id === 'profile-a')
    const retained = stored.find((item: { id: string }) => item.id === 'profile-b')
    assert.equal(kept.apiKey, undefined)
    assert.equal(kept.label, 'Work')
    assert.equal(kept.model, 'gpt-4o')
    assert.equal(kept.note, 'keep-me')
    assert.equal(retained.apiKey, 'second-secret-value')
    assert.equal(logs.join('\n').includes(SENTINEL), false)

    const second = await migrateLegacyModelSecrets(async input => {
      calls.push('again:' + input.id)
      return { durable: false, accepted: false, sessionOnly: false }
    })
    assert.deepEqual(second.scrubbedIds, [])
    assert.equal(calls.filter(id => id === 'profile-a').length, 1)
    assert.equal(calls.includes('again:profile-a'), false)
    assert.equal(JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[1].apiKey, 'second-secret-value')
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
})

test('session-only and failed migration keep the only legacy copy', async () => {
  localStorage.clear()
  localStorage.setItem(MODELS_KEY, JSON.stringify([{ ...profile(), apiKey: SENTINEL }]))
  const session = await migrateLegacyModelSecrets(async () => ({ durable: false, accepted: true, sessionOnly: true }))
  assert.equal(session.warning?.includes('this session only'), true)
  assert.equal(session.scrubbedIds.length, 0)
  assert.equal(JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[0].apiKey, SENTINEL)

  const mismatch = await migrateLegacyModelSecrets(async () => ({ durable: false, accepted: true, sessionOnly: false }))
  assert.equal(mismatch.scrubbedIds.length, 0)
  assert.equal(JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[0].apiKey, SENTINEL)

  writeProfilesPreservingRetainedSecrets(loadModelProfiles(), new Set(['profile-a']))
  const preserved = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[0]
  assert.equal(preserved.apiKey, SENTINEL)
  assert.equal(preserved.model, 'gpt-4o')
})

test('a retained key is not transferred to a provider chosen later', async () => {
  localStorage.clear()
  localStorage.setItem(MODELS_KEY, JSON.stringify([{ ...profile(), provider: 'openai', apiKey: SENTINEL }]))
  writeProfilesPreservingRetainedSecrets(
    [{ ...profile(), provider: 'anthropic', label: 'Renamed' }],
    new Set(['profile-a']),
  )
  const stored = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[0]
  assert.equal(stored.provider, 'anthropic')
  assert.equal(stored.secretProvider, 'openai')
  assert.equal(stored.apiKey, SENTINEL)
  const seen: string[] = []
  const outcome = await migrateLegacyModelSecrets(async input => {
    seen.push(input.provider)
    assert.equal(input.apiKey, SENTINEL)
    return { durable: true, accepted: true, sessionOnly: false }
  })
  assert.deepEqual(seen, ['openai'])
  assert.deepEqual(outcome.scrubbedIds, ['profile-a'])
  const scrubbed = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[0]
  assert.equal(scrubbed.provider, 'anthropic')
  assert.equal(scrubbed.apiKey, undefined)
  assert.equal(scrubbed.secretProvider, undefined)
  assert.equal(JSON.stringify(scrubbed).includes(SENTINEL), false)
})

test('transfer helper scrubs only when PUT and GET both report keyring', async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method || 'GET'} ${url}`)
    const body = typeof init?.body === 'string' ? init.body : ''
    assert.equal(url.includes(SENTINEL), false)
    if ((init?.method || 'GET') === 'PUT') {
      const sent = JSON.parse(body) as { provider?: string; api_key?: string }
      assert.equal(sent.provider, 'openai')
      assert.equal(sent.api_key, SENTINEL)
      return new Response(JSON.stringify({
        has_key: true,
        hint: '••••9f2c',
        mode: 'keyring',
        persistent: true,
        source: 'profile',
      }), { status: 200 })
    }
    assert.equal(body.includes(SENTINEL), false)
    return new Response(JSON.stringify({
      has_key: true,
      hint: '••••9f2c',
      mode: 'keyring',
      persistent: true,
      source: 'profile',
    }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await transferLegacyCredential({ id: 'profile-a', provider: 'openai', apiKey: SENTINEL })
    assert.equal(result.durable, true)
    assert.equal(calls.length, 2)
    assert.equal(calls.some(call => call.includes(SENTINEL)), false)
  } finally {
    globalThis.fetch = original
  }
})

test('chat payload and credential draft never carry a stored key', () => {
  const body = buildChatRequest({
    message: 'hello',
    document: '<p>x</p>',
    selection: '',
    history: [{ role: 'user', content: 'hi' }],
    profile: profile(),
  })
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes(SENTINEL), false)
  assert.equal(serialized.includes('api_key'), false)
  assert.equal(serialized.includes('apiKey'), false)
  assert.equal(body.profile_id, 'profile-a')
  assert.equal(body.base_url, 'https://example.invalid/v1')

  assert.equal(reduceCredentialDraft('typed', { type: 'open' }), '')
  assert.equal(reduceCredentialDraft('typed', { type: 'save-success' }), '')
  assert.equal(reduceCredentialDraft('typed', { type: 'cancel' }), '')
  assert.equal(reduceCredentialDraft('typed', { type: 'close' }), '')
  assert.equal(draftFromStatus({ hint: SENTINEL, has_key: true }), '')
  assert.equal(credentialStatusLine({
    has_key: true,
    hint: '••••9f2c',
    mode: 'keyring',
    persistent: true,
    source: 'profile',
    unbound_profile_credential: false,
  }, false).includes('system keyring'), true)
  assert.equal(credentialStatusLine({
    has_key: true,
    hint: '',
    mode: 'memory',
    persistent: false,
    source: 'profile',
    unbound_profile_credential: false,
  }, false), 'Available for this session only')
  assert.equal(credentialStatusLine(null, true).includes('backend'), true)
  assert.equal(credentialStatusLine(null, false), 'No API key for this model')
})

test('model profiles are not written into IndexedDB', async () => {
  await deleteDocumentDb()
  localStorage.clear()
  saveModelProfiles([{ ...profile(), apiKey: SENTINEL } as ModelProfile])
  const db = await getDocumentDb()
  assert.deepEqual([...db.objectStoreNames].sort(), ['documents', 'versions'])
  const documents = await db.getAll('documents')
  const versions = await db.getAll('versions')
  const dumped = JSON.stringify({ documents, versions })
  assert.equal(dumped.includes(SENTINEL), false)
  await closeDocumentDb()
})

test('frontend sources no longer post secrets to /api/config', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const panel = read('../components/AIPanel.tsx')
  const manager = read('../components/ModelManager.tsx')
  const toolbar = read('../components/Toolbar.tsx')
  assert.equal(panel.includes('/api/config'), false)
  assert.equal(panel.includes('syncActiveModelToBackend'), false)
  assert.equal(panel.includes('api_key'), false)
  assert.equal(manager.includes('/api/config'), false)
  assert.equal(manager.includes('api_key'), false)
  assert.equal(toolbar.includes('ApiKeyDialog'), false)
  const index = readFileSync(`${root}index.html`, 'utf8')
  assert.equal(index.includes('fonts.googleapis.com'), false)
  assert.equal(index.includes('fonts.gstatic.com'), false)
  const tauri = JSON.parse(readFileSync(`${root}../src-tauri/tauri.conf.json`, 'utf8'))
  const csp = JSON.stringify(tauri.app.security.csp)
  assert.equal(tauri.app.security.csp === null, false)
  assert.equal(csp.includes('*'), false)
  assert.equal(csp.includes('http://127.0.0.1:8000'), false)
  assert.equal(csp.includes('fonts.googleapis.com'), false)
})
