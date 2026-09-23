import type { ModelProfile } from './storage.ts'

export interface ChatHistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export function buildChatRequest(input: {
  message: string
  document: string
  selection: string
  history: ChatHistoryTurn[]
  profile: ModelProfile
}) {
  return {
    message: input.message,
    document: input.document,
    selection: input.selection,
    history: input.history.map(turn => ({ role: turn.role, content: turn.content })),
    profile_id: input.profile.id,
    provider: input.profile.provider,
    model: input.profile.model,
    base_url: input.profile.baseUrl,
  }
}
