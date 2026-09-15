import { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import {
  createDocxEditorExtensions,
  type HeadlessWithout,
} from '../extensions/createDocxEditorExtensions.ts'

export interface HeadlessHarness {
  editor: Editor
  /** view.dispatch calls whose transaction has docChanged */
  docChangedDispatches: number
  attemptedDispatches: number
  appliedDocChanged: number
  destroy: () => void
  resetCounts: () => void
}

export function paragraphsHtml(texts: string[]): string {
  return texts.map(text => `<p>${escapeHtml(text)}</p>`).join('')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function createHeadlessEditor(input: {
  html: string
  isLocked?: () => boolean
  without?: readonly HeadlessWithout[]
}): HeadlessHarness {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createDocxEditorExtensions({
      environment: 'headless',
      isLocked: input.isLocked,
      without: input.without,
    }),
    content: input.html,
    parseOptions: { preserveWhitespace: true },
    injectCSS: false,
    autofocus: false,
  })

  const harness: HeadlessHarness = {
    editor,
    docChangedDispatches: 0,
    attemptedDispatches: 0,
    appliedDocChanged: 0,
    destroy: () => { editor.destroy() },
    resetCounts: () => {
      harness.docChangedDispatches = 0
      harness.attemptedDispatches = 0
      harness.appliedDocChanged = 0
    },
  }

  const orig = editor.view.dispatch.bind(editor.view)
  editor.view.dispatch = (tr: Transaction) => {
    harness.attemptedDispatches += 1
    if (tr.docChanged) harness.docChangedDispatches += 1
    orig(tr)
  }
  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) harness.appliedDocChanged += 1
  })
  harness.resetCounts()
  return harness
}

export function blockTexts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach(node => { out.push(node.textContent) })
  return out
}
