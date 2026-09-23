import { apiUrl } from './api.ts'
import type { ModelProvider } from './storage.ts'
import type { TransferResult } from './legacyModelMigration.ts'

export type CredentialMode = 'keyring' | 'memory' | 'environment' | 'unavailable'

export interface CredentialStatus {
  has_key: boolean
  hint: string
  mode: CredentialMode
  persistent: boolean
  source: string
}

export function credentialStatusLine(status: CredentialStatus | null, backendDown: boolean): string {
  if (backendDown) return 'Could not check the key. Is the backend running?'
  if (!status || !status.has_key || status.mode === 'unavailable') return 'No API key for this model'
  if (status.mode === 'keyring') {
    return status.hint ? `Stored in the system keyring · ${status.hint}` : 'Stored in the system keyring'
  }
  if (status.mode === 'memory') return 'Available for this session only'
  if (status.mode === 'environment') return 'Using a key from the environment'
  return 'No API key for this model'
}

function asStatus(value: unknown): CredentialStatus {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const mode = record.mode
  return {
    has_key: record.has_key === true,
    hint: typeof record.hint === 'string' ? record.hint : '',
    mode: mode === 'keyring' || mode === 'memory' || mode === 'environment' ? mode : 'unavailable',
    persistent: record.persistent === true,
    source: typeof record.source === 'string' ? record.source : 'missing',
  }
}

export async function getCredentialStatus(profileId: string, provider: ModelProvider): Promise<CredentialStatus> {
  const res = await fetch(apiUrl(`/api/credentials/${encodeURIComponent(profileId)}?provider=${encodeURIComponent(provider)}`))
  if (!res.ok) throw new Error('credential status failed')
  return asStatus(await res.json())
}

export async function putCredential(profileId: string, provider: ModelProvider, apiKey: string): Promise<CredentialStatus> {
  const res = await fetch(apiUrl(`/api/credentials/${encodeURIComponent(profileId)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, provider }),
  })
  if (!res.ok) throw new Error('credential save failed')
  const text = await res.text()
  if (text.includes(apiKey)) throw new Error('credential response was rejected')
  return asStatus(JSON.parse(text))
}

export async function deleteCredential(profileId: string, provider: ModelProvider): Promise<void> {
  const res = await fetch(apiUrl(`/api/credentials/${encodeURIComponent(profileId)}?provider=${encodeURIComponent(provider)}`), {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('credential delete failed')
}

export async function rebindUnscopedCredential(profileId: string, provider: ModelProvider): Promise<void> {
  const res = await fetch(apiUrl(`/api/credentials/${encodeURIComponent(profileId)}/rebind`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  })
  if (!res.ok) throw new Error('credential rebind failed')
}

export async function testStoredCredential(
  profileId: string,
  provider: ModelProvider,
  model: string,
  baseUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(apiUrl(`/api/credentials/${encodeURIComponent(profileId)}/test`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, base_url: baseUrl }),
  })
  if (!res.ok) return { ok: false, error: 'Could not test the key. Is the backend running?' }
  const data = await res.json()
  return { ok: data.ok === true, error: typeof data.error === 'string' ? data.error : undefined }
}

export async function transferLegacyCredential(input: {
  id: string
  provider: ModelProvider
  apiKey: string
}): Promise<TransferResult> {
  let putText = ''
  try {
    const put = await fetch(apiUrl(`/api/credentials/${encodeURIComponent(input.id)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: input.apiKey, provider: input.provider }),
    })
    putText = await put.text()
    if (!put.ok || putText.includes(input.apiKey)) {
      return { durable: false, accepted: false, sessionOnly: false }
    }
    const putBody = asStatus(JSON.parse(putText))
    const got = await getCredentialStatus(input.id, input.provider)
    const durable = putBody.mode === 'keyring' && putBody.persistent && got.mode === 'keyring' && got.has_key && got.persistent
    return {
      durable,
      accepted: true,
      sessionOnly: !durable && putBody.mode === 'memory' && putBody.has_key,
    }
  } catch {
    return { durable: false, accepted: false, sessionOnly: false }
  }
}
