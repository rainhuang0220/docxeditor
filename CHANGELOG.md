# Changelog

## Unreleased (`main`)

Engineering work after the v0.1.0 desktop preview. No new tagged app build yet.

### AI editing integrity

- Capture document, selection, cursor, revision, and thread identity at request time
- Ignore mutating results if that identity no longer matches
- Route selection-menu actions through the same request path as the AI panel

### Document transaction safety

- Stop writing the document while the model is still streaming
- Interrupted or incomplete streams leave the document unchanged
- Confirmable edits lock the editor until Accept or Reject
- Reject restores the pre-edit snapshot and does not leave the proposal on Undo/Redo

### Operation validation

- Decode model JSON into a typed operation union before planning
- Reject the whole batch on unknown types, bad fields, or out-of-range block indexes
- Apply a valid multi-operation result as one ProseMirror transaction

### Document durability

- Store the current document and version history in IndexedDB instead of localStorage
- Migrate legacy `ai-doc-ide-document` / `ai-doc-ide-versions` once, only after the copy verifies
- Serialize autosave so an older write cannot replace a newer document
- Keep pending AI proposals out of durable storage until Accept
- Surface save failures in the status bar instead of polling localStorage

### Tests

- Frontend suite for stream, review, lock, history, revision, decode, preflight, atomic apply, and document durability
- Backend continuation smoke tests remain

## 0.1.0 — 2026-08-02

macOS Apple Silicon desktop preview. See [GitHub Releases](https://github.com/rainhuang0220/docxeditor/releases/tag/v0.1.0).
