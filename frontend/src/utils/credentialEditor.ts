export type CredentialDraftEvent =
  | { type: 'open' }
  | { type: 'type'; apiKey: string }
  | { type: 'save-success' }
  | { type: 'cancel' }
  | { type: 'close' }

export function reduceCredentialDraft(_current: string, event: CredentialDraftEvent): string {
  if (event.type === 'type') return event.apiKey
  return ''
}

export function draftFromStatus(_status: unknown): string {
  return ''
}
