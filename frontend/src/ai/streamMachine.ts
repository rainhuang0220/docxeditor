/**
 * Document-safety state machine for one AIPanel SSE (or fallback) request.
 * Holds no HTML: snapshot text stays in the editor adapter.
 */

const LIVE_WRITE_TOOLS = new Set(['replace_content', 'insert_at_end'])

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

export type Effect = 'stopLive' | 'restore' | 'applyResult' | 'markIncomplete'

export interface MachineState {
  phase: Phase
  live: boolean
  mutated: boolean
}

export function initialState(): MachineState {
  return { phase: 'idle', live: false, mutated: false }
}

export function isLiveWriteTool(name: string): boolean {
  return LIVE_WRITE_TOOLS.has(name)
}

export function reduce(state: MachineState, event: ChatEvent): {
  state: MachineState
  effects: Effect[]
} {
  if (event.type === 'start') {
    if (state.phase !== 'idle') return { state, effects: [] }
    return { state: { phase: 'streaming', live: false, mutated: false }, effects: [] }
  }

  if (state.phase !== 'streaming') {
    return { state, effects: [] }
  }

  switch (event.type) {
    case 'tool_start':
    case 'tool_delta':
      return markLive(state, event.name)
    case 'done':
    case 'fallback':
      return succeed(state, event.operationsCount)
    case 'error':
      return fail(state, 'failed')
    case 'abort':
      return fail(state, 'aborted')
    case 'eof':
      return fail(state, 'incomplete')
  }
}

function markLive(state: MachineState, name: string): { state: MachineState; effects: Effect[] } {
  const live = isLiveWriteTool(name)
  if (!live) return { state, effects: [] }
  return {
    state: { ...state, live: true, mutated: true },
    effects: [],
  }
}

function succeed(state: MachineState, operationsCount: number): { state: MachineState; effects: Effect[] } {
  const next: MachineState = { ...state, phase: 'completed' }
  if (operationsCount > 0) {
    return { state: next, effects: ['stopLive', 'applyResult'] }
  }
  if (state.mutated) {
    return { state: next, effects: ['stopLive', 'restore'] }
  }
  return { state: next, effects: ['stopLive'] }
}

function fail(
  state: MachineState,
  phase: 'failed' | 'aborted' | 'incomplete',
): { state: MachineState; effects: Effect[] } {
  const effects: Effect[] = ['stopLive']
  if (state.mutated) effects.push('restore')
  if (phase === 'incomplete') effects.push('markIncomplete')
  return { state: { ...state, phase }, effects }
}
