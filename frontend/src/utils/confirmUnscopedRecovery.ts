import { apiFetch } from './api.ts'
import {
  UNBOUND_CREDENTIAL_WARNING,
  getCredentialStatus,
  type CredentialStatus,
} from './credentials.ts'
import type { ModelProvider } from './storage.ts'

export { UNBOUND_CREDENTIAL_WARNING }

export type UnscopedRecoveryReason =
  | 'not-confirmed'
  | 'request-failed'
  | 'not-unbound'
  | 'already-scoped'
  | 'not-profile'
  | 'still-unbound'
  | 'other-provider'
  | 'response-rejected'

export interface UnscopedRecoveryResult {
  ok: boolean
  reason: UnscopedRecoveryReason | null
  status: CredentialStatus | null
  message: string
}

const FAILURE = 'Recovery did not complete. The earlier credential is still unconfirmed.'

export async function discardEarlierCredential(profileId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/credentials/${encodeURIComponent(profileId)}/discard-unscoped`, {
      method: 'POST',
    })
    if (!res.ok) return false
    const data = await res.json()
    return data.discarded === true && data.unbound_profile_credential === false
  } catch {
    return false
  }
}

function rejectedBody(text: string): boolean {
  return text.includes('api_key') || text.includes('apiKey')
}

export async function confirmUnscopedRecovery(input: {
  profileId: string
  provider: ModelProvider
  confirmed: boolean
}): Promise<UnscopedRecoveryResult> {
  if (input.confirmed !== true) {
    return { ok: false, reason: 'not-confirmed', status: null, message: FAILURE }
  }
  let before: CredentialStatus
  try {
    before = await getCredentialStatus(input.profileId, input.provider)
  } catch {
    return { ok: false, reason: 'request-failed', status: null, message: FAILURE }
  }
  if (!before.unbound_profile_credential) {
    return { ok: false, reason: 'not-unbound', status: before, message: FAILURE }
  }
  if (before.source === 'profile' && before.has_key) {
    return { ok: false, reason: 'already-scoped', status: before, message: FAILURE }
  }
  let posted: CredentialStatus
  try {
    const res = await apiFetch(`/api/credentials/${encodeURIComponent(input.profileId)}/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: input.provider }),
    })
    const text = await res.text()
    if (!res.ok || rejectedBody(text)) {
      return { ok: false, reason: res.ok ? 'response-rejected' : 'request-failed', status: before, message: FAILURE }
    }
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: 'response-rejected', status: before, message: FAILURE }
    }
    posted = parsed as CredentialStatus
    const record = parsed as Record<string, unknown>
    if (record.other_profile_same_secret === true) {
      return { ok: false, reason: 'other-provider', status: before, message: FAILURE }
    }
    if (record.rebound !== true) {
      return {
        ok: false,
        reason: record.unbound_profile_credential === true ? 'still-unbound' : 'not-profile',
        status: record.unbound_profile_credential === true ? posted : before,
        message: FAILURE,
      }
    }
  } catch {
    return { ok: false, reason: 'request-failed', status: before, message: FAILURE }
  }
  if (posted.source !== 'profile' || posted.has_key !== true || posted.unbound_profile_credential !== false) {
    return {
      ok: false,
      reason: posted.unbound_profile_credential ? 'still-unbound' : 'not-profile',
      status: posted.unbound_profile_credential ? posted : before,
      message: FAILURE,
    }
  }
  let chosen: CredentialStatus
  try {
    chosen = await getCredentialStatus(input.profileId, input.provider)
  } catch {
    return { ok: false, reason: 'request-failed', status: before, message: FAILURE }
  }
  if (chosen.source !== 'profile' || !chosen.has_key || chosen.unbound_profile_credential) {
    return {
      ok: false,
      reason: chosen.unbound_profile_credential ? 'still-unbound' : 'not-profile',
      status: chosen.unbound_profile_credential ? chosen : before,
      message: FAILURE,
    }
  }
  return { ok: true, reason: null, status: chosen, message: 'The earlier credential is now saved for this provider.' }
}
