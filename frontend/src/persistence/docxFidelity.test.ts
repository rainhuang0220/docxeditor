import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHeadlessEditor } from '../test/headlessEditor.ts'
import { applyVerifiedReplacement } from './editorReplacement.ts'
import { loadCurrentDocument, saveCurrentDocument } from './documentStore.ts'
import { interpretImportResponse } from './importDocx.ts'
import { cssToTwip, DEFAULT_PAGE_SETTINGS } from './pageSettings.ts'
import { resetPersistence } from './testUtils.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('a failed import response is not a document', () => {
  const rejected = interpretImportResponse(422, { error: { code: 'invalid_docx', message: 'The document could not be opened.' } })
  assert.equal(rejected.ok, false)
  const missing = interpretImportResponse(200, { warnings: [] })
  assert.equal(missing.ok, false)
})

test('a successful import keeps html, twips, and warnings', () => {
  const imported = interpretImportResponse(200, {
    html: '<p>Hi</p>',
    page_settings: {
      widthTwip: 12240,
      heightTwip: 15840,
      marginTopTwip: 1440,
      marginRightTwip: 1440,
      marginBottomTwip: 1440,
      marginLeftTwip: 1440,
    },
    warnings: ['Headers and footers are not imported.'],
  })
  assert.equal(imported.ok, true)
  if (!imported.ok) return
  assert.equal(imported.html, '<p>Hi</p>')
  assert.equal(imported.pageSettings?.widthTwip, 12240)
  assert.equal(imported.warnings[0], 'Headers and footers are not imported.')
})

test('page settings verify even when property order differs', async () => {
  await resetPersistence()
  const letter = {
    marginBottomTwip: 1080,
    widthTwip: 12240,
    marginRightTwip: 1800,
    heightTwip: 15840,
    marginLeftTwip: 1440,
    marginTopTwip: 720,
  }
  const saved = await saveCurrentDocument('<p>Letter</p>', '2026-09-24T00:02:00.000Z', letter)
  assert.equal(saved.pageSettings?.widthTwip, 12240)
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status === 'ok') assert.equal(loaded.record.pageSettings?.marginTopTwip, 720)
})

test('page settings stay with the document record across an html save', async () => {
  await resetPersistence()
  const letter = { ...DEFAULT_PAGE_SETTINGS, widthTwip: 12240, heightTwip: 15840 }
  await saveCurrentDocument('<p>Letter</p>', '2026-09-24T00:00:00.000Z', letter)
  await saveCurrentDocument('<p>Letter edited</p>', '2026-09-24T00:01:00.000Z')
  const loaded = await loadCurrentDocument()
  assert.equal(loaded.status, 'ok')
  if (loaded.status !== 'ok') return
  assert.equal(loaded.record.html, '<p>Letter edited</p>')
  assert.equal(loaded.record.pageSettings?.widthTwip, 12240)
  assert.equal(loaded.record.pageSettings?.heightTwip, 15840)
})

test('a trailing list or table still replaces the document', () => {
  const harness = createHeadlessEditor({ html: '<p>old</p>' })
  assert.equal(applyVerifiedReplacement(harness.editor, '<ol><li><p>One</p></li></ol>'), true)
  assert.match(harness.editor.getHTML(), /One/)
  assert.equal(applyVerifiedReplacement(harness.editor, '<table><tbody><tr><th data-background-color="#00FF00"><p>Head</p></th></tr></tbody></table>'), true)
  assert.match(harness.editor.getHTML(), /00FF00/)
  assert.match(harness.editor.getHTML(), /Head/)
  harness.destroy()
})

test('css page presets match OOXML twips', () => {
  assert.equal(cssToTwip('210mm'), 11906)
  assert.equal(cssToTwip('297mm'), 16838)
  assert.equal(cssToTwip('8.5in'), 12240)
  assert.equal(cssToTwip('11in'), 15840)
  assert.equal(cssToTwip('25.4mm'), 1440)
})

test('a zero margin is a real page setting', async () => {
  const { parsePageSettings } = await import('./pageSettings.ts')
  const parsed = parsePageSettings({
    widthTwip: 12240,
    heightTwip: 15840,
    marginTopTwip: 0,
    marginRightTwip: 1440,
    marginBottomTwip: 0,
    marginLeftTwip: 1440,
  })
  assert.equal(parsed?.marginTopTwip, 0)
  assert.equal(parsed?.widthTwip, 12240)
})

test('headless TipTap keeps spans, image order, and list start', () => {
  const harness = createHeadlessEditor({
    html: `<table><tbody><tr><td colspan="2" rowspan="1"><p>H</p></td></tr><tr><td colspan="1" rowspan="1"><p>A</p></td><td colspan="1" rowspan="1"><p>B</p></td></tr></tbody></table><p>BEFORE</p><img src="data:image/png;base64,${PNG}" /><p>AFTER</p><ol start="5"><li><p>Five</p></li></ol>`,
  })
  const html = harness.editor.getHTML()
  assert.match(html, /colspan="2"/)
  assert.ok(html.indexOf('BEFORE') < html.indexOf('<img') && html.indexOf('<img') < html.indexOf('AFTER'))
  assert.match(html, /start="5"/)
  harness.destroy()
})
