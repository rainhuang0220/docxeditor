/**
 * Document-safety state machine for one AIPanel SSE (or fallback) request.
 * Holds no HTML. Pre-terminal events never imply a canonical document mutation.
 */

export type Phase =
  | 'idle'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'incomplete'

export type ChatEvent =
  | { type: 'start' }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_delta'; name: string }
  | { type: 'done'; operationsCount: number }
  | { type: 'error' }
  | { type: 'abort' }
  | { type: 'eof' }
  | { type: 'fallback'; operationsCount: number }

export type Effect = 'applyResult' | 'markIncomplete'

export interface MachineState {
  phase: Phase
}

export function initialState(): MachineState {
  return { phase: 'idle' }
}

export function reduce(state: MachineState, event: ChatEvent): {
  state: MachineState
  effects: Effect[]
} {
  if (event.type === 'start') {
    if (state.phase !== 'idle') return { state, effects: [] }
    return { state: { phase: 'streaming' }, effects: [] }
  }

  if (state.phase !== 'streaming') {
    return { state, effects: [] }
  }

  switch (event.type) {
    case 'tool_start':
    case 'tool_delta':
      return { state, effects: [] }
    case 'done':
    case 'fallback':
      return {
        state: { phase: 'completed' },
        effects: event.operationsCount > 0 ? ['applyResult'] : [],
      }
    case 'error':
      return { state: { phase: 'failed' }, effects: [] }
    case 'abort':
      return { state: { phase: 'aborted' }, effects: [] }
    case 'eof':
      return { state: { phase: 'incomplete' }, effects: ['markIncomplete'] }
  }
}
