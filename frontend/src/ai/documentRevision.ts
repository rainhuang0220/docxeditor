import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'

export const DOCUMENT_REVISION_KEY = new PluginKey<number>('documentRevision')

export function createDocumentRevisionPlugin(): Plugin<number> {
  return new Plugin<number>({
    key: DOCUMENT_REVISION_KEY,
    state: {
      init(): number {
        return 0
      },
      apply(tr: Transaction, value: number): number {
        return tr.docChanged ? value + 1 : value
      },
    },
  })
}

export function getDocumentRevision(state: EditorState): number {
  const value = DOCUMENT_REVISION_KEY.getState(state)
  if (value === undefined) {
    throw new Error('documentRevision plugin is not installed')
  }
  return value
}
