import { MODELS_KEY, saveModelProfiles, type ModelProfile, type ModelProvider } from './storage.ts'
import { writeProfilesPreservingRetainedSecrets } from './legacyModelMigration.ts'

export type ModelDeletionReason =
  | 'removed'
  | 'last-model'
  | 'legacy-retained'
  | 'credential-delete-failed'

export interface ModelDeletionResult {
  removed: boolean
  reason: ModelDeletionReason
  message: string | null
  models: ModelProfile[]
}

function isStoredSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (value === '***') return false
  if (value.length <= 12 && (value.endsWith('…') || value.endsWith('...'))) return false
  return true
}

function rawProfiles(): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : []
  } catch {
    return []
  }
}

export function profileHasRetainedSecret(id: string): boolean {
  return rawProfiles().some(record => record.id === id && isStoredSecret(record.apiKey))
}

export function planProviderCredentialWrite(input: {
  previousProvider: ModelProvider
  nextProvider: ModelProvider
  typedKey: string
}): { putApiKey: string | null; provider: ModelProvider; providerChanged: boolean } {
  const typed = input.typedKey.trim()
  return {
    putApiKey: typed || null,
    provider: input.nextProvider,
    providerChanged: input.previousProvider !== input.nextProvider,
  }
}

export async function commitModelDeletion(input: {
  id: string
  provider: ModelProvider
  models: readonly ModelProfile[]
  discardRetainedLegacy: boolean
  deleteRemote: (id: string, provider: ModelProvider) => Promise<void>
}): Promise<ModelDeletionResult> {
  const models = input.models.map(model => ({ ...model }))
  if (models.length <= 1) {
    return {
      removed: false,
      reason: 'last-model',
      message: 'At least one model has to stay.',
      models,
    }
  }
  if (profileHasRetainedSecret(input.id) && !input.discardRetainedLegacy) {
    return {
      removed: false,
      reason: 'legacy-retained',
      message: 'This model still has a saved API key on this device. It was not deleted.',
      models,
    }
  }
  try {
    await input.deleteRemote(input.id, input.provider)
  } catch {
    return {
      removed: false,
      reason: 'credential-delete-failed',
      message: 'Could not delete the API key. This model was kept. Is the backend running?',
      models,
    }
  }
  const remaining = models.filter(model => model.id !== input.id)
  const retained = new Set(
    rawProfiles()
      .filter(record => typeof record.id === 'string' && record.id !== input.id && isStoredSecret(record.apiKey))
      .map(record => String(record.id)),
  )
  if (retained.size > 0) writeProfilesPreservingRetainedSecrets(remaining, retained)
  else saveModelProfiles(remaining)
  return { removed: true, reason: 'removed', message: null, models: remaining }
}
