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

### Credential ownership

- Model profiles stored in the browser no longer include API keys
- The backend stores a key in the OS keyring when that store works, or in process memory for the current session when it does not
- Chat requests carry the model profile, not the key. Provider clients are built for that request
- Legacy frontend profile keys and `~/.docxeditor/config.json` `api_key` move only after the new copy is read back
- Browser and desktop origins are an explicit list. Production Tauri CSP is set, and the UI no longer loads Google Fonts

### Tests

- Frontend suite for stream, review, lock, history, revision, decode, preflight, atomic apply, and document durability
- Backend continuation smoke tests remain

## 0.1.0 — 2026-08-02

macOS Apple Silicon desktop preview. See [GitHub Releases](https://github.com/rainhuang0220/docxeditor/releases/tag/v0.1.0).
