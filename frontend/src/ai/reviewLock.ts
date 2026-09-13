import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { Node } from '@tiptap/pm/model'

/** PluginKey used as transaction meta so authorization is not a public string. */
export const REVIEW_LOCK_META = new PluginKey('reviewLock')

export type ReviewLockMeta = {
  restore?: boolean
  authorizeRestore?: boolean
}

export function allowReviewTransaction(opts: {
  pending: boolean
  docChanged: boolean
  storedMarksSet: boolean
  restoreAuthorized: boolean
  restoreMeta: boolean
}): boolean {
  if (!opts.pending) return true
  if (opts.docChanged) return opts.restoreMeta && opts.restoreAuthorized
  if (opts.storedMarksSet) return false
  return true
}

export function createReviewLockPlugin(isPending: () => boolean): Plugin {
  let restoreAuthorized = false

  return new Plugin({
    key: REVIEW_LOCK_META,
    filterTransaction(tr: Transaction) {
      const meta = tr.getMeta(REVIEW_LOCK_META) as ReviewLockMeta | undefined
      if (!isPending()) {
        restoreAuthorized = false
        return true
      }
      if (!tr.docChanged && !tr.storedMarksSet && meta?.authorizeRestore) {
        restoreAuthorized = true
      }
      const allowed = allowReviewTransaction({
        pending: true,
        docChanged: tr.docChanged,
        storedMarksSet: tr.storedMarksSet,
        restoreAuthorized,
        restoreMeta: meta?.restore === true,
      })
      if (allowed && tr.docChanged && meta?.restore === true) {
        restoreAuthorized = false
      }
      return allowed
    },
  })
}

export function authorizeRestoreTr(state: EditorState): Transaction {
  return state.tr.setMeta(REVIEW_LOCK_META, { authorizeRestore: true } satisfies ReviewLockMeta)
}

export function restoreSnapshotTr(state: EditorState, snapshot: Node): Transaction {
  return state.tr
    .replaceWith(0, state.doc.content.size, snapshot.content)
    .setMeta(REVIEW_LOCK_META, { restore: true } satisfies ReviewLockMeta)
}
