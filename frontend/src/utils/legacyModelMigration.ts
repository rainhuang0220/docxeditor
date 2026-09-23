import { MODELS_KEY, type ModelProfile, type ModelProvider } from './storage.ts'

export interface TransferResult {
  durable: boolean
  accepted: boolean
  sessionOnly: boolean
}

export interface MigrationOutcome {
  warning: string | null
  retainedIds: string[]
  scrubbedIds: string[]
  requests: number
}

const SESSION_WARNING =
  'Persistent secure storage is unavailable. Your API key is available for this session only; the saved copy was kept.'

const FAILED_WARNING =
  'Could not move a saved API key. The old copy was kept.'

function isMask(value: string): boolean {
  if (value === '***') return true
  if (value.length <= 12 && (value.endsWith('…') || value.endsWith('...'))) return true
  return false
}

function providerOf(record: Record<string, unknown>): ModelProvider | null {
  if (record.provider === 'openai' || record.provider === 'anthropic') return record.provider
  return null
}

function withoutSecret(record: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'apiKey' || key === 'keyHint') continue
    next[key] = value
  }
  return next
}

export async function migrateLegacyModelSecrets(
  transfer: (input: { id: string; provider: ModelProvider; apiKey: string }) => Promise<TransferResult>,
): Promise<MigrationOutcome> {
  const empty: MigrationOutcome = { warning: null, retainedIds: [], scrubbedIds: [], requests: 0 }
  let raw: string | null
  try {
    raw = localStorage.getItem(MODELS_KEY)
  } catch {
    return empty
  }
  if (!raw) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!Array.isArray(parsed)) return empty

  const secrets: { id: string; provider: ModelProvider; apiKey: string }[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) continue
    if (typeof record.apiKey !== 'string' || !record.apiKey || isMask(record.apiKey)) continue
    const provider = providerOf(record)
    if (!provider) continue
    secrets.push({ id: record.id, provider, apiKey: record.apiKey })
  }
  if (secrets.length === 0) return empty

  const scrubbed = new Set<string>()
  let sessionOnly = false
  let failed = false
  let requests = 0
  for (const secret of secrets) {
    requests += 1
    let result: TransferResult
    try {
      result = await transfer(secret)
    } catch {
      failed = true
      continue
    }
    if (result.durable) {
      scrubbed.add(secret.id)
      continue
    }
    if (result.sessionOnly) sessionOnly = true
    else failed = true
  }

  if (scrubbed.size > 0) {
    const next = parsed.map(item => {
      if (!item || typeof item !== 'object') return item
      const record = item as Record<string, unknown>
      if (typeof record.id === 'string' && scrubbed.has(record.id)) return withoutSecret(record)
      return item
    })
    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify(next))
    } catch {
      return {
        warning: 'Your API key was stored securely, but the old copy could not be removed.',
        retainedIds: secrets.map(secret => secret.id),
        scrubbedIds: [],
        requests,
      }
    }
  }

  const retainedIds = secrets.filter(secret => !scrubbed.has(secret.id)).map(secret => secret.id)
  let warning: string | null = null
  if (sessionOnly) warning = SESSION_WARNING
  else if (failed || retainedIds.length > 0) warning = FAILED_WARNING
  return {
    warning,
    retainedIds,
    scrubbedIds: [...scrubbed],
    requests,
  }
}

export function writeProfilesPreservingRetainedSecrets(
  profiles: ModelProfile[],
  retained: ReadonlySet<string>,
) {
  let existing: unknown[] = []
  try {
    const raw = localStorage.getItem(MODELS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) existing = parsed
  } catch {
    existing = []
  }
  const byId = new Map<string, Record<string, unknown>>()
  for (const item of existing) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id === 'string') byId.set(record.id, record)
  }
  const next: Array<{ id: string }> = profiles.map(profile => {
    const pub = {
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
    }
    if (!retained.has(profile.id)) return pub
    const previous = byId.get(profile.id)
    const secret = previous && typeof previous.apiKey === 'string' ? previous.apiKey : ''
    if (!secret) return pub
    return { ...pub, apiKey: secret }
  })
  const written = new Set(next.map(profile => profile.id))
  for (const id of retained) {
    if (written.has(id)) continue
    const previous = byId.get(id)
    const secret = previous && typeof previous.apiKey === 'string' ? previous.apiKey : ''
    if (!secret) continue
    next.push(previous as { id: string })
  }
  localStorage.setItem(MODELS_KEY, JSON.stringify(next))
}
