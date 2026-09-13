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
  | 'export'

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

export function canExportDocument(phase: ReviewPhase): boolean {
  return phase !== 'pending'
}

export function persistableHtml(
  phase: ReviewPhase,
  snapshot: string | null,
  editorHtml: string,
): string {
  if (phase === 'pending' && snapshot !== null) return snapshot
  return editorHtml
}

export function planDeleteModel(input: {
  models: readonly { id: string }[]
  activeModelId: string
  deleteId: string
  review: ReviewState
}): {
  allowed: boolean
  models: { id: string }[]
  activeModelId: string
  review: ReviewState
} {
  const models = [...input.models]
  if (models.length <= 1) {
    return { allowed: true, models, activeModelId: input.activeModelId, review: input.review }
  }
  if (input.deleteId === input.activeModelId && input.review.phase === 'pending') {
    return { allowed: false, models, activeModelId: input.activeModelId, review: input.review }
  }
  const next = models.filter(m => m.id !== input.deleteId)
  return {
    allowed: true,
    models: next,
    activeModelId: input.deleteId === input.activeModelId
      ? (next[0]?.id ?? input.activeModelId)
      : input.activeModelId,
    review: input.review,
  }
}
