/**
 * Accept/Reject transaction for a confirmable AI document mutation.
 * Holds no HTML. Snapshot text stays in the editor adapter.
 */

export const REVIEW_BLOCK_MESSAGE =
  'Accept or reject the current AI edit before starting another request.'

export type ReviewPhase = 'idle' | 'pending' | 'committed' | 'rejected'

export interface ReviewState {
  phase: ReviewPhase
}

export function initialReviewState(): ReviewState {
  return { phase: 'idle' }
}

export type SessionAction =
  | 'send'
  | 'newChat'
  | 'switchThread'
  | 'switchModel'
  | 'closePanel'
  | 'deleteThread'
  | 'mutateDocument'

export type ReviewEvent =
  | { type: 'applied'; operationsCount: number; confirmable: boolean }
  | { type: 'accept' }
  | { type: 'reject' }
  | { type: 'intend'; action: SessionAction }

export type ReviewEffect = 'enterPending' | 'clearSnapshot' | 'commit' | 'restore'

export interface ReviewReduceResult {
  state: ReviewState
  effects: ReviewEffect[]
  allowed: boolean
}

export function reduceReview(state: ReviewState, event: ReviewEvent): ReviewReduceResult {
  if (event.type === 'intend') {
    if (state.phase === 'pending') {
      return { state, effects: [], allowed: false }
    }
    return { state, effects: [], allowed: true }
  }

  if (event.type === 'applied') {
    if (state.phase === 'pending') {
      return { state, effects: [], allowed: false }
    }
    if (event.operationsCount <= 0) {
      return { state, effects: [], allowed: true }
    }
    if (event.confirmable) {
      return { state: { phase: 'pending' }, effects: ['enterPending'], allowed: true }
    }
    return { state: { phase: 'idle' }, effects: ['clearSnapshot'], allowed: true }
  }

  if (event.type === 'accept') {
    if (state.phase !== 'pending') return { state, effects: [], allowed: false }
    return { state: { phase: 'committed' }, effects: ['commit'], allowed: true }
  }

  if (event.type === 'reject') {
    if (state.phase !== 'pending') return { state, effects: [], allowed: false }
    return { state: { phase: 'rejected' }, effects: ['restore'], allowed: true }
  }

  return { state, effects: [], allowed: true }
}

export function guardReviewAction(state: ReviewState, action: SessionAction): ReviewReduceResult {
  return reduceReview(state, { type: 'intend', action })
}

export function persistableHtml(
  phase: ReviewPhase,
  snapshot: string | null,
  editorHtml: string,
): string {
  if (phase === 'pending' && snapshot !== null) return snapshot
  return editorHtml
}
