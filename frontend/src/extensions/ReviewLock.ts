import { Extension } from '@tiptap/core'
import { createReviewLockPlugin } from '../ai/reviewLock'

export const ReviewLock = Extension.create<{ isLocked: () => boolean }>({
  name: 'reviewLock',
  addOptions() {
    return { isLocked: () => false }
  },
  addProseMirrorPlugins() {
    return [createReviewLockPlugin(() => this.options.isLocked())]
  },
})
