import type { Node } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { getDocumentRevision } from './documentRevision.ts'
import type { RequestAnchor } from './operationTarget.ts'

export const STALE_RESULT_MESSAGE =
  'The document changed while the AI was working, so the edit was not applied. Please retry.'

export interface RequestContext {
  requestId: string
  source: 'panel' | 'selection'
  documentRevision: number
  documentNode: Node
  documentHtml: string
  anchor: RequestAnchor
  originatingThreadId: string
  originatingModelId: string
}

export function captureAnchor(state: EditorState): RequestAnchor {
  const { from, to } = state.selection
  return {
    from,
    to,
    cursor: from,
    selectedText: from !== to ? state.doc.textBetween(from, to, ' ') : '',
  }
}

export function captureRequestContext(input: {
  requestId: string
  source: 'panel' | 'selection'
  state: EditorState
  html: string
  threadId: string
  modelId: string
  anchor?: RequestAnchor
}): RequestContext {
  if (!input.threadId) {
    throw new Error('RequestContext requires a concrete originatingThreadId')
  }
  return {
    requestId: input.requestId,
    source: input.source,
    documentRevision: getDocumentRevision(input.state),
    documentNode: input.state.doc,
    documentHtml: input.html,
    anchor: input.anchor ?? captureAnchor(input.state),
    originatingThreadId: input.threadId,
    originatingModelId: input.modelId,
  }
}

/** Synchronously obtain a concrete owning thread id before RequestContext capture. */
export function requireOwningThreadId(
  activeThreadId: string | null | undefined,
  createThread: () => string,
): string | null {
  if (typeof activeThreadId === 'string' && activeThreadId.length > 0) return activeThreadId
  const created = createThread()
  if (typeof created !== 'string' || created.length === 0) return null
  return created
}

export function isMutatingResultStale(input: {
  state: EditorState
  ctx: RequestContext
  liveRequestId: string | null
  liveThreadId: string | null
}): boolean {
  if (input.liveRequestId !== input.ctx.requestId) return true
  if (!input.liveThreadId || input.liveThreadId !== input.ctx.originatingThreadId) return true
  if (getDocumentRevision(input.state) !== input.ctx.documentRevision) return true
  if (!input.state.doc.eq(input.ctx.documentNode)) return true
  return false
}
