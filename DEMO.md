# Demo notes

Prefer the browser path. Desktop AI still depends on a local FastAPI process.

```bash
npm run dev
```

Open http://localhost:5173. Set a provider key via the toolbar key icon (saved to `~/.docxeditor/config.json`) or `.env`.

Status bar **AI Ready** means the backend process is up, not that the key is valid.

## Script

1. **Editor.** Show the A4 page, outline, formatting, and that this is TipTap HTML — not Microsoft Word.
2. **AI edit.** Ask to change the title and insert a small table. Chat streams in the panel; the document updates when the request finishes. Destructive edits show Accept / Reject. Reject restores the previous document and must not come back through Undo.
3. **Selection.** Select text, use the bubble menu or the AI panel. The range used is the one captured at send, even if the caret moves while the model runs.
4. **Export.** Export `.docx` and open it in Word/Pages. Expect headings, tables, and basic formatting — not a lossless round-trip.

If the panel errors, re-save the key. If port 8000 is taken, stop the other process and rerun `npm run dev`.
