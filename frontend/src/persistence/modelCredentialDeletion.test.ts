import assert from 'node:assert/strict'
import { test } from 'node:test'

import { commitModelDeletion, planProviderCredentialWrite } from '../utils/modelCredentialDeletion.ts'
import { MODELS_KEY, type ModelProfile } from '../utils/storage.ts'
import { writeProfilesPreservingRetainedSecrets } from '../utils/legacyModelMigration.ts'

const SENTINEL = 'DOCXEDITOR_SECRET_SENTINEL_9f2c'

function models(): ModelProfile[] {
  return [
    { id: 'profile-a', label: 'GPT', provider: 'openai', model: 'gpt-4o', baseUrl: '' },
    { id: 'profile-b', label: 'Claude', provider: 'anthropic', model: 'claude', baseUrl: '' },
  ]
}

test('profile deletion orchestration keeps metadata when revocation fails', async () => {
  localStorage.clear()
  localStorage.setItem(MODELS_KEY, JSON.stringify([
    { ...models()[0], apiKey: SENTINEL },
    models()[1],
  ]))
  let calls = 0
  const blocked = await commitModelDeletion({
    id: 'profile-a',
    provider: 'openai',
    models: models(),
    discardRetainedLegacy: false,
    deleteRemote: async () => { calls += 1 },
  })
  assert.equal(blocked.removed, false)
  assert.equal(blocked.reason, 'legacy-retained')
  assert.equal(calls, 0)
  assert.equal(JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[0].apiKey, SENTINEL)

  const failed = await commitModelDeletion({
    id: 'profile-a',
    provider: 'openai',
    models: models(),
    discardRetainedLegacy: true,
    deleteRemote: async () => { throw new Error('down') },
  })
  assert.equal(failed.removed, false)
  assert.equal(failed.reason, 'credential-delete-failed')
  assert.equal(failed.message?.includes('was kept'), true)
  assert.equal(failed.message?.includes('removed'), false)
  assert.equal(JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')[0].apiKey, SENTINEL)
  assert.equal(failed.models.length, 2)

  const discarded = await commitModelDeletion({
    id: 'profile-a',
    provider: 'openai',
    models: models(),
    discardRetainedLegacy: true,
    deleteRemote: async (id, provider) => {
      assert.equal(id, 'profile-a')
      assert.equal(provider, 'openai')
    },
  })
  assert.equal(discarded.removed, true)
  const stored = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')
  assert.equal(stored.some((item: { id: string }) => item.id === 'profile-a'), false)
  assert.equal(JSON.stringify(stored).includes(SENTINEL), false)
  assert.equal(stored[0].id, 'profile-b')
})

test('ordinary delete of a profile without a legacy key removes it only after DELETE', async () => {
  localStorage.clear()
  localStorage.setItem(MODELS_KEY, JSON.stringify(models()))
  const failed = await commitModelDeletion({
    id: 'profile-b',
    provider: 'anthropic',
    models: models(),
    discardRetainedLegacy: false,
    deleteRemote: async () => { throw new Error('503') },
  })
  assert.equal(failed.removed, false)
  assert.equal(JSON.parse(localStorage.getItem(MODELS_KEY) || '[]').length, 2)

  const removed = await commitModelDeletion({
    id: 'profile-b',
    provider: 'anthropic',
    models: models(),
    discardRetainedLegacy: false,
    deleteRemote: async () => {},
  })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.models.map(model => model.id), ['profile-a'])
})

test('omitted retained profile is written back instead of losing its key', () => {
  localStorage.clear()
  localStorage.setItem(MODELS_KEY, JSON.stringify([
    { ...models()[0], apiKey: SENTINEL },
    models()[1],
  ]))
  writeProfilesPreservingRetainedSecrets([models()[1]], new Set(['profile-a', 'profile-b']))
  const stored = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')
  const kept = stored.find((item: { id: string }) => item.id === 'profile-a')
  assert.equal(kept.apiKey, SENTINEL)
})

test('provider change does not invent a credential write', () => {
  const changed = planProviderCredentialWrite({
    previousProvider: 'openai',
    nextProvider: 'anthropic',
    typedKey: '',
  })
  assert.equal(changed.putApiKey, null)
  assert.equal(changed.providerChanged, true)
  const typed = planProviderCredentialWrite({
    previousProvider: 'openai',
    nextProvider: 'anthropic',
    typedKey: 'new-key-only',
  })
  assert.equal(typed.putApiKey, 'new-key-only')
  assert.equal(typed.provider, 'anthropic')
})
