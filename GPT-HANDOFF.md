# Engineering handoff

Read this before changing AI document mutation. It describes **current `main`**, not the original spec and not the `withgpt/` snapshot.

Product: DocxEditor — React 19 + TipTap 3 + FastAPI + Tauri 2. MoonBit/Wasm is **not** implemented. Do not replace TipTap or invent a second document engine.

Priority remains: document correctness > recoverability > persistence > truthful state > UX > features.

## Where the living code is

| Area | Path |
|---|---|
| Decode | `frontend/src/ai/operations.ts` |
| Preflight + atomic apply | `frontend/src/ai/applyOperations.ts` |
| Request identity / staleness | `frontend/src/ai/requestContext.ts` |
| Stream terminal machine | `frontend/src/ai/streamMachine.ts` |
| Review phase | `frontend/src/ai/reviewTransaction.ts` |
| Mutation firewall | `frontend/src/ai/reviewLock.ts` |
| History-safe reject | `frontend/src/ai/reviewHistory.ts` |
| Revision | `frontend/src/ai/documentRevision.ts` |
| In-flight latch | `frontend/src/ai/requestLatch.ts` |
| UI apply / send | `frontend/src/components/AIPanel.tsx` |
| Selection menu | `frontend/src/components/SelectionMenu.tsx` (UI only; calls `submitAIRequest`) |
| Tools + conversion | `backend/ai_service.py` `_tool_call_to_operation` |

`withgpt/` is a frozen pre-I01 snapshot (live-write, OOB append, `console.warn` skip). Do not patch it. Do not commit it.

Tests: `cd frontend && npm test` and `python3 -m backend.test_continuation`.

## Invariants (I01–I03)

### Streaming

- `tool_start` / `tool_delta` must not mutate the document.
- Only terminal `done` / `fallback` with operations may emit `applyResult`.
- Abort, error, and EOF-without-success fail closed. There is nothing to restore because nothing was written.

### Request context

- Capture document node, HTML, revision, selection/cursor, request id, owning thread id, and model **before any await**.
- Apply uses those anchors, never the live caret.
- First request must obtain a concrete thread id before capture. `originatingThreadId === null` is not trusted.
- Stale request / thread / revision / node → do not apply.

### Shared request path

- SelectionMenu must not fetch, stream, or apply. It opens the panel and calls `submitAIRequest`.

### Operations

```text
raw JSON
  → decodeOperations (unknown → AiOperation[])
  → planOperations (original document)
  → one transaction
  → review when confirmation is required
```

- Unknown type, bad fields, over-limit batch, OOB `paragraph_index` → entire batch rejected.
- Do not `console.warn` and continue.
- Do not append on OOB replace, no-op on OOB delete, or insert-at-end on OOB insert-after.
- Block indexes refer to **original** numbering and are mapped through the same transaction.
- `replace_content` must not mix with other ops. Two destructive ops on the same original block are invalid.

### Atomic apply

- Build every step on one ProseMirror transaction. Dispatch once, or not at all (`preventDispatch` on failure).
- A successful batch is one history event (`closeHistory` on that tr).

### Review / history

- Confirmable apply → pending. ReviewLock blocks ordinary `docChanged` mutations.
- Accept once. Undo after Accept returns the pre-AI document.
- Reject restores the request-time node and history checkpoint. Redo must not resurrect the proposal.
- Pending persistable HTML is the pre-edit snapshot, not the proposal.
- Pending blocks send, new chat, thread/model switch, export.

## What not to do

- Do not reintroduce live-write.
- Do not reopen SelectionMenu as a second executor unless a regression proves it broken.
- Do not treat backend tool JSON as typed without `decodeOperations`.
- Do not start a MoonBit / engine rewrite from this file.

## Remaining product debt (not done)

DOCX fidelity, real Python sidecar in the DMG, DiffView quality, plaintext keys, CSP, header/footer as real sections, provider UX, persistence beyond localStorage.
