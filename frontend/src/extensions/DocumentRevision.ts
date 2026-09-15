import { Extension } from '@tiptap/core'
import { createDocumentRevisionPlugin } from '../ai/documentRevision.ts'

export const DocumentRevision = Extension.create({
  name: 'documentRevision',
  addProseMirrorPlugins() {
    return [createDocumentRevisionPlugin()]
  },
})
