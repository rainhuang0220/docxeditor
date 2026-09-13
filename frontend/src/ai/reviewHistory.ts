import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { Node } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { restoreSnapshotTr } from './reviewLock.ts'

export interface HistoryCheckpoint {
  key: PluginKey
  state: unknown
}

export function findHistoryPlugin(state: EditorState): Plugin | undefined {
  return state.plugins.find(p => {
    const key = (p as Plugin & { key: string }).key
    return typeof key === 'string' && key.startsWith('history$')
  })
}

export function checkpointHistory(state: EditorState): HistoryCheckpoint | null {
  const plugin = findHistoryPlugin(state)
  const key = plugin?.spec.key
  if (!plugin || !key) return null
  return { key, state: plugin.getState(state) }
}

export function stampHistoryCheckpoint(tr: Transaction, checkpoint: HistoryCheckpoint): Transaction {
  return tr.setMeta(checkpoint.key, { historyState: checkpoint.state })
}

export function stampAppendedTransaction(tr: Transaction, first: Transaction): Transaction {
  return tr.setMeta('appendedTransaction', first)
}

export function rejectRestoreTr(
  state: EditorState,
  snapshot: Node,
  checkpoint: HistoryCheckpoint | null,
): Transaction {
  let tr = restoreSnapshotTr(state, snapshot)
  if (checkpoint) tr = stampHistoryCheckpoint(tr, checkpoint)
  return tr
}

export function closeHistoryTr(state: EditorState): Transaction {
  return closeHistory(state.tr)
}

/** Run a block of editor dispatches as one history event. */
export function dispatchAsSingleHistoryEvent(
  view: { dispatch: (tr: Transaction) => void; state: EditorState },
  run: () => void,
): void {
  const orig = view.dispatch.bind(view)
  orig(closeHistoryTr(view.state))
  let first: Transaction | null = null
  view.dispatch = (tr: Transaction) => {
    if (tr.docChanged) {
      if (!first) first = tr
      else stampAppendedTransaction(tr, first)
    }
    orig(tr)
  }
  try {
    run()
  } finally {
    view.dispatch = orig
  }
}
