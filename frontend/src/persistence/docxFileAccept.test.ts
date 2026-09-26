import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOCX_FILE_ACCEPT, isDocxFileCandidate } from './docxFileAccept.ts'

test('picker accept stays unrestricted so WKWebView Open is not stuck disabled', () => {
  // Prior packaged smoke: accept=".docx" hid fixtures and left Open disabled.
  assert.equal(DOCX_FILE_ACCEPT, '')
})

test('docx candidacy accepts name or MIME; rejects unrelated files', () => {
  assert.equal(isDocxFileCandidate({ name: 'Proposal.docx' }), true)
  assert.equal(isDocxFileCandidate({ name: 'Proposal.DOCX' }), true)
  assert.equal(
    isDocxFileCandidate({
      name: 'download',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    true,
  )
  assert.equal(isDocxFileCandidate({ name: 'notes.txt', type: 'text/plain' }), false)
  assert.equal(isDocxFileCandidate({ name: 'archive.zip' }), false)
})
