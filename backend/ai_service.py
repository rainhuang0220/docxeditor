import os
import json
import re
from typing import AsyncGenerator
from openai import AsyncOpenAI

# How much of the document we send to the model up front. Blocks beyond this
# budget are shown as one-line previews, and the model pages through the rest
# with the read_blocks tool (see below). The old fixed 4000-char cap silently
# hid later chapters from the model, which then "deleted" them on full rewrites.
DOC_CHAR_LIMIT = int(os.environ.get("AI_DOC_CHAR_LIMIT", "120000"))
MAX_TOKENS = int(os.environ.get("AI_MAX_TOKENS", "16384"))
# Per-call budget of the read_blocks tool, and the round budget of one chat
# request. A round is one model call: reading blocks, queueing edits, or an
# auto-continuation after the output-length limit cuts a response off.
READ_BLOCKS_CHAR_LIMIT = int(os.environ.get("AI_READ_BLOCKS_CHAR_LIMIT", "40000"))
MAX_AGENT_ROUNDS = int(os.environ.get("AI_MAX_AGENT_ROUNDS", "40"))
# How many times one request may push the model back to work when it declares
# an edit task finished. The checkpoint compares queued edits against the full
# block list, so a lazy "done" after one edit no longer ends the task.
MAX_CHECK_NUDGES = int(os.environ.get("AI_MAX_CHECK_NUDGES", "3"))
# Previews of blocks beyond the initial budget: first N plain-text chars per
# block, plus a total cap so thousands of previews can't flood the context.
PREVIEW_BLOCK_CHARS = 80
PREVIEW_TOTAL_CHARS = 20000

QUEUED_EDIT_ACK = (
    "Queued. This edit will be applied to the document after you finish all "
    "operations (block indices always refer to the original numbering). Do not "
    "repeat this edit."
)

# Sent as a user message when the model's response is cut off by the output
# length limit mid-task, so it resumes in the SAME conversation instead of
# handing the half-done task back to the user.
CONTINUATION_NUDGE = (
    "[system] Your previous response was cut off by the output length limit "
    "before the task was finished. Continue NOW from exactly where you stopped: "
    "re-emit the one edit that was cut off, then keep processing the remaining "
    "blocks. Block indices still refer to the original [n] numbering. Do not "
    "repeat edits that were already queued, do not restart from the beginning, "
    "and do not stop to ask whether to continue - finish the whole task."
)

# Soft checkpoint after a round that queued edits. {gap_clause} is either a
# concrete list of still-missing blocks, or a generic coverage reminder.
CHECK_NUDGE = (
    "[system] Checkpoint before finishing: you have queued {n} edit(s) so far, "
    "and the document has blocks [0]..[{last}]. {gap_clause}"
    "Indices still refer to the original [n] numbering. Do not repeat queued "
    "edits, do not restart, do not ask whether to continue. Only if everything "
    "is truly covered, reply with ONE short confirmation sentence and no tool calls."
)

# Hard nudge when the model claims "done" with text only, but heading-like
# blocks that the instruction covers still have no queued edit. This is the
# main fix for "reply looks complete, but only the first heading was edited".
HARD_CHECK_NUDGE = (
    "[system] You confirmed done, but coverage check FAILED. These blocks still "
    "have NO queued edit even though the instruction covers them: {missing}. "
    "Emit replace_paragraph for EACH missing block NOW as tool calls (one per "
    "block). Do not reply with only text. Do not ask to continue. Indices refer "
    "to the original [n] numbering."
)

_ROUNDS_EXHAUSTED_WARNING = (
    "The document is very long: the AI reached its step limit before "
    "finishing. Send the instruction again to have it continue where it stopped."
)

_COVERAGE_WARNING = (
    "Some blocks may still need edits: {count} heading-like block(s) were not "
    "modified ({missing}). Send the same instruction again to continue where it stopped."
)

SYSTEM_PROMPT = """You are the AI agent inside an AI-native Word IDE. The left panel shows the
user a rendered Word document; you modify it ONLY by calling tools. You are a
document manipulation system, not a text generator.

The document is given to you as a numbered list of top-level blocks:
[0] <h1>...</h1>
[1] <p>...</p>
Each [n] is the block_index used by the block-level tools.

## Golden rules
1. NEVER lose user content. Every block you do not explicitly edit must remain
   untouched. If an instruction covers the whole document, your operations must
   cover ALL blocks from the first to the last one.
2. Prefer surgical block-level edits: replace_paragraph, insert_after_paragraph,
   delete_paragraph. You may and should emit MANY tool calls in one response
   (e.g. one replace_paragraph per heading you fix).
3. replace_content (full rewrite) is allowed ONLY when generating a brand-new
   document from scratch, or when the user explicitly asks to rebuild the whole
   document AND it is short enough for you to reproduce completely. If you use
   it, the content MUST contain the ENTIRE document - every chapter, section and
   paragraph. Never use "...", never omit sections, never write placeholders
   like "(remaining chapters unchanged)".
4. If the document context says later blocks are shown as PREVIEWS only (long
   document), replace_content is FORBIDDEN. Read the full blocks with
   read_blocks and edit block by block instead.

## Heading structure (VERY IMPORTANT)
Word documents use real heading levels, never fake ones:
- NEVER simulate a heading with a bold or centered <p>. Always use <h1>/<h2>/<h3>.
- The document title: <h1 style="text-align: center">Title</h1>.
- Chapter level ("第一章", "第1章", "Chapter 1", "一、二、三、") -> <h1>
- Section level ("1.1", "第一节", "（一）", "Section 1.1") -> <h2>
- Subsection level ("1.1.1", "1.2.3") -> <h3>
- Body text stays in <p>.
When the user asks to format / beautify / 排版 / "加标题" a document, analyze
EVERY block, detect from its numbering and content whether it is a chapter,
section, or subsection heading, and convert each such block with
replace_paragraph (e.g. content "<h1>第一章 绪论</h1>"). Do this for the whole
document, not just the beginning.

## Long documents: previews and read_blocks
When the document is long, later blocks appear as one-line previews ("+N more
chars" means you are NOT seeing the whole block):
- Call read_blocks(start_index, end_index) to fetch full block content, ~20-40
  blocks at a time, until you have seen everything the task needs.
- You may mix read_blocks and edit operations in one response. Edits are queued
  and applied after you finish, against the ORIGINAL [n] numbering - indices
  never shift. Never queue the same edit twice.
- Use replace_paragraph ONLY on blocks whose full content you have seen (in the
  main listing, via read_blocks, or as a complete preview without "+N more
  chars").
- When the task covers the whole document, work through ALL of it: read a
  section, queue its edits, read the next section, repeat to the last block.

## Finish the whole task in ONE conversation (CRITICAL)
- NEVER pause after finishing a section to ask "shall I continue?" / "需要我继续吗".
  When a task spans multiple sections, keep reading and queueing edits until
  EVERY block it covers has been handled; only then write your final summary.
- If you receive a system note that your previous output was cut off, resume
  immediately from the first edit that was not yet queued. Never restart from
  the beginning, never repeat queued edits, never apologize.

## Content rules
- Tool `content` fields take clean HTML fragments: <h1>-<h3>, <p>, <strong>,
  <em>, <u>, <table>, <ul>, <ol>, <blockquote>. Inline styles are allowed,
  e.g. style="text-align: center".
- Never put Markdown into the document. No ``` fences, no # headings.
- Use <strong> sparingly: only for short key terms of a few words. NEVER bold
  entire sentences or paragraph lead-ins (e.g. "第一，...", "（一）...",
  "对...的建议："). Formal documents read best with plain body text.
- Keep the document's own language. Reply to the user in the user's language
  (中文用户用中文回复).

## Interaction style
- FIRST write one short sentence saying what you are about to do, THEN call the
  tools. After the tools, no long explanations - one or two sentences on what
  changed is enough.
- Set requires_confirmation=true for rewrites, deletions and restructuring;
  false for small insertions and pure formatting.
- Only ask a clarifying question when the request is genuinely ambiguous AND
  guessing wrong would destroy work. Otherwise act.
"""

ANTHROPIC_TOOLS = [
    {
        "name": "replace_content",
        "description": "Replace the ENTIRE document with new HTML. Only for generating a new document from scratch or an explicit full rebuild. The content MUST include every part of the document; anything omitted is permanently deleted.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Complete HTML content for the whole document"},
                "requires_confirmation": {"type": "boolean", "description": "True if this is a major rewrite that changes meaning", "default": True},
                "preview": {"type": "string", "description": "Brief summary of what changes"}
            },
            "required": ["content"]
        }
    },
    {
        "name": "insert_at_cursor",
        "description": "Insert HTML content at the current cursor position in the document.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "HTML content to insert at cursor"}
            },
            "required": ["content"]
        }
    },
    {
        "name": "insert_at_end",
        "description": "Append HTML content at the end of the document.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "HTML content to append"}
            },
            "required": ["content"]
        }
    },
    {
        "name": "read_blocks",
        "description": "Read the FULL content of a range of top-level document blocks (the [n] numbers). Use this to read parts of a long document that were only shown as previews. This does not modify the document.",
        "input_schema": {
            "type": "object",
            "properties": {
                "start_index": {"type": "integer", "description": "First block index to read (inclusive)"},
                "end_index": {"type": "integer", "description": "Last block index to read (inclusive)"}
            },
            "required": ["start_index", "end_index"]
        }
    },
    {
        "name": "insert_after_paragraph",
        "description": "Insert HTML content after the top-level block with the given block_index (the [n] numbers in the document context).",
        "input_schema": {
            "type": "object",
            "properties": {
                "paragraph_index": {"type": "integer", "description": "0-based block index [n] to insert after"},
                "content": {"type": "string", "description": "HTML content to insert"}
            },
            "required": ["paragraph_index", "content"]
        }
    },
    {
        "name": "replace_paragraph",
        "description": "Replace one top-level block with new HTML. paragraph_index is the [n] number from the document context. Use this to rewrite a paragraph, or to convert a paragraph into a heading (content '<h1>...</h1>').",
        "input_schema": {
            "type": "object",
            "properties": {
                "paragraph_index": {"type": "integer", "description": "0-based block index [n] to replace"},
                "content": {"type": "string", "description": "New HTML for this block"},
                "requires_confirmation": {"type": "boolean", "default": True},
                "preview": {"type": "string", "description": "Brief summary of what changes"}
            },
            "required": ["paragraph_index", "content"]
        }
    },
    {
        "name": "delete_paragraph",
        "description": "Delete the top-level block with the given block_index ([n] in the document context).",
        "input_schema": {
            "type": "object",
            "properties": {
                "paragraph_index": {"type": "integer", "description": "0-based block index [n] to delete"},
                "requires_confirmation": {"type": "boolean", "default": True}
            },
            "required": ["paragraph_index"]
        }
    },
    {
        "name": "format_selection",
        "description": "Apply formatting to the current selection or all text. Supports: bold, italic, underline, strikethrough, highlight, heading, alignment, font_family, font_size, color.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["bold", "italic", "underline", "strikethrough", "highlight", "heading", "align", "font_family", "font_size", "color"],
                    "description": "The formatting action to apply"
                },
                "value": {"type": "string", "description": "Value for the action (e.g. heading level '1'-'3', alignment 'center', font name, size '14pt', color '#ff0000')"}
            },
            "required": ["action"]
        }
    },
    {
        "name": "insert_table",
        "description": "Insert a table at the cursor position.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rows": {"type": "integer", "description": "Number of rows", "default": 3},
                "cols": {"type": "integer", "description": "Number of columns", "default": 3}
            },
            "required": []
        }
    },
    {
        "name": "insert_list",
        "description": "Insert an ordered or unordered list.",
        "input_schema": {
            "type": "object",
            "properties": {
                "list_type": {"type": "string", "enum": ["ordered", "unordered"]},
                "items": {"type": "array", "items": {"type": "string"}, "description": "List item texts"}
            },
            "required": ["list_type", "items"]
        }
    },
    {
        "name": "insert_horizontal_rule",
        "description": "Insert a horizontal rule/divider.",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "insert_code_block",
        "description": "Insert a code block.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Code content"},
                "language": {"type": "string", "description": "Programming language"}
            },
            "required": ["content"]
        }
    },
    {
        "name": "insert_blockquote",
        "description": "Insert a blockquote.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Text content for the blockquote"}
            },
            "required": ["content"]
        }
    },
    {
        "name": "insert_image",
        "description": "Insert an image into the document.",
        "input_schema": {
            "type": "object",
            "properties": {
                "src": {"type": "string", "description": "URL of the image"},
                "alt": {"type": "string", "description": "Alt text description"}
            },
            "required": ["src"]
        }
    },
    {
        "name": "set_link",
        "description": "Add a hyperlink to the current selection.",
        "input_schema": {
            "type": "object",
            "properties": {
                "href": {"type": "string", "description": "URL for the link"}
            },
            "required": ["href"]
        }
    },
    {
        "name": "replace_selection",
        "description": "Replace the currently selected text with new HTML content. Use this when the user asks to rewrite, rephrase, or transform selected text.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "HTML content to replace the selection with"},
                "requires_confirmation": {"type": "boolean", "description": "True if this significantly changes meaning", "default": False},
                "preview": {"type": "string", "description": "Brief summary of what changes"}
            },
            "required": ["content"]
        }
    }
]

# OpenAI function definitions (equivalent to ANTHROPIC_TOOLS)
OPENAI_TOOLS = [
    {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}
    for t in ANTHROPIC_TOOLS
]

# Operations whose accidental application with empty content can destroy the
# document. These always go through the frontend Accept/Reject review.
FORCE_CONFIRMATION_TOOLS = {"replace_content", "delete_paragraph", "replace_paragraph"}


# ---------------------------------------------------------------------------
# Document context: number the document's top-level blocks so the model can
# address them individually, and so it always sees the FULL document.
# ---------------------------------------------------------------------------

_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
_TAG_RE = re.compile(r"<(/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s(?:[^>\"']|\"[^\"]*\"|'[^']*')*)?/?>")


def split_top_level_blocks(html: str) -> list:
    """Split an HTML fragment (as produced by the editor) into its top-level blocks."""
    blocks = []
    depth = 0
    start = None
    for m in _TAG_RE.finditer(html):
        closing = m.group(1) == "/"
        tag = m.group(2).lower()
        self_closing = m.group(0).endswith("/>") or tag in _VOID_TAGS
        if closing:
            depth -= 1
            if depth == 0 and start is not None:
                blocks.append(html[start:m.end()])
                start = None
            depth = max(depth, 0)
        else:
            if depth == 0 and start is None:
                start = m.start()
            if not self_closing:
                depth += 1
            elif depth == 0 and start is not None:
                blocks.append(html[start:m.end()])
                start = None
    return [b.strip() for b in blocks if b.strip()]


_BLOCK_TAG_RE = re.compile(r"\s*<([a-zA-Z][a-zA-Z0-9-]*)")
_STRIP_TAGS_RE = re.compile(r"<[^>]+>")


def _block_preview(html: str, limit: int = PREVIEW_BLOCK_CHARS) -> tuple[str, bool]:
    """One-line plain-text preview of a block. Returns (preview, is_complete)."""
    m = _BLOCK_TAG_RE.match(html)
    tag = f"<{m.group(1).lower()}>" if m else ""
    text = _STRIP_TAGS_RE.sub("", html)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        return f"{tag} {text[:limit]}… (+{len(text) - limit} more chars)", False
    return f"{tag} {text}", True


class DocumentView:
    """Server-side view of the document for one chat request.

    Holds the numbered top-level blocks, builds the model-facing context (full
    blocks up to DOC_CHAR_LIMIT, then one-line previews), tracks which blocks
    the model has fully SEEN (initial listing, complete previews, read_blocks
    results), and executes read_blocks calls. The `seen` set lets _build_result
    reject edits to blocks the model never read - the main source of lost
    content with long documents.
    """

    def __init__(self, document: str):
        self.blocks: list[str] = []
        if document and document.strip():
            self.blocks = split_top_level_blocks(document) or [document]
        self.truncated_at: int | None = None
        self.preview_until = 0
        self.seen: set[int] = set()
        self._previews: dict[int, str] = {}

        total = 0
        for i, b in enumerate(self.blocks):
            line_len = len(f"[{i}] {b}") + 1
            if total + line_len > DOC_CHAR_LIMIT:
                self.truncated_at = i
                break
            total += line_len
            self.seen.add(i)

        if self.truncated_at is not None:
            preview_total = 0
            self.preview_until = self.truncated_at
            for j in range(self.truncated_at, len(self.blocks)):
                preview, complete = _block_preview(self.blocks[j])
                plen = len(f"[{j}] {preview}") + 1
                if preview_total + plen > PREVIEW_TOTAL_CHARS:
                    break
                self._previews[j] = preview
                preview_total += plen
                self.preview_until = j + 1
                if complete:
                    self.seen.add(j)

    def context_text(self, selection: str) -> str:
        """The document section of the prompt."""
        if not self.blocks:
            text = "The document is currently EMPTY."
        else:
            last_full = self.truncated_at if self.truncated_at is not None else len(self.blocks)
            lines = [f"[{i}] {self.blocks[i]}" for i in range(last_full)]
            text = (
                "Current document as numbered top-level blocks "
                "(use [n] as paragraph_index in block tools):\n" + "\n".join(lines)
            )
            if self.truncated_at is not None:
                n = len(self.blocks)
                preview_lines = [f"[{j}] {self._previews[j]}" for j in sorted(self._previews)]
                text += (
                    f"\n\nThis document is LONG: {n} blocks total. Blocks "
                    f"{self.truncated_at}..{n - 1} are NOT shown in full above. "
                    "Short previews:\n" + "\n".join(preview_lines)
                )
                if self.preview_until < n:
                    text += f"\n… plus blocks {self.preview_until}..{n - 1} (previews omitted)."
                text += (
                    "\n\nUse read_blocks(start_index, end_index) to read the FULL content "
                    "of any blocks you need to edit. replace_content is FORBIDDEN for "
                    "this document."
                )
        if selection:
            text += f"\n\nThe user has currently selected this text:\n{selection[:2000]}"
        return text

    def read(self, start, end) -> str:
        """Execute a read_blocks call: full content of blocks [start..end],
        capped at READ_BLOCKS_CHAR_LIMIT per call. Marks returned blocks seen."""
        try:
            start = int(start)
            end = int(end)
        except (TypeError, ValueError):
            return "Error: start_index and end_index must be integers."
        if not self.blocks:
            return "The document is empty."
        start = max(0, start)
        end = min(len(self.blocks) - 1, end)
        if start > end:
            return f"No blocks in that range. The document has blocks 0..{len(self.blocks) - 1}."
        out = []
        total = 0
        i = start
        while i <= end:
            line = f"[{i}] {self.blocks[i]}"
            if out and total + len(line) > READ_BLOCKS_CHAR_LIMIT:
                break
            out.append(line)
            total += len(line) + 1
            self.seen.add(i)
            i += 1
        text = "\n".join(out)
        if i <= end:
            text += f"\n(Read limit reached. Call read_blocks again from block {i} to continue.)"
        return text

    def read_json(self, raw_arguments: str) -> str:
        """read() from a raw JSON argument string; tolerant of malformed JSON."""
        try:
            args = json.loads(raw_arguments) if raw_arguments else {}
        except json.JSONDecodeError:
            return "Error: malformed arguments. Provide integer start_index and end_index."
        return self.read(args.get("start_index"), args.get("end_index"))

    def has_unseen_blocks(self) -> bool:
        return self.truncated_at is not None


# ---------------------------------------------------------------------------
# Incremental extraction of the "content" string field from streaming tool-call
# JSON, so the frontend can render the document text live while the model writes.
# ---------------------------------------------------------------------------

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "/": "/", "\\": "\\", '"': '"'}


class ContentFieldExtractor:
    """Incrementally decode the string value of the "content" key while the
    tool-call JSON is still streaming."""

    def __init__(self):
        self.buf = ""
        self.pos = 0
        self.state = 0  # 0=searching key, 1=expect colon+quote, 2=inside string, 3=finished
        self._pending_high = None  # high surrogate awaiting its pair

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = []
        while self.pos < len(self.buf):
            if self.state == 0:
                idx = self.buf.find('"content"', self.pos)
                if idx == -1:
                    # Keep a small tail so a key split across chunks is still found.
                    self.pos = max(self.pos, len(self.buf) - 12)
                    break
                self.pos = idx + 9
                self.state = 1
            elif self.state == 1:
                ch = self.buf[self.pos]
                if ch in " \t\r\n:":
                    self.pos += 1
                elif ch == '"':
                    self.pos += 1
                    self.state = 2
                else:
                    self.state = 3  # not a string value; give up
            elif self.state == 2:
                ch = self.buf[self.pos]
                if ch == "\\":
                    if self.pos + 1 >= len(self.buf):
                        break  # escape split across chunks; wait for more
                    esc = self.buf[self.pos + 1]
                    if esc == "u":
                        if self.pos + 6 > len(self.buf):
                            break
                        try:
                            cp = int(self.buf[self.pos + 2:self.pos + 6], 16)
                            out.append(self._emit_codepoint(cp))
                        except ValueError:
                            pass
                        self.pos += 6
                    else:
                        out.append(_ESCAPES.get(esc, esc))
                        self.pos += 2
                elif ch == '"':
                    self.state = 3
                    self.pos += 1
                else:
                    out.append(ch)
                    self.pos += 1
            else:
                break
        return "".join(out)

    def _emit_codepoint(self, cp: int) -> str:
        if 0xD800 <= cp <= 0xDBFF:
            self._pending_high = cp
            return ""
        if 0xDC00 <= cp <= 0xDFFF and self._pending_high is not None:
            combined = 0x10000 + ((self._pending_high - 0xD800) << 10) + (cp - 0xDC00)
            self._pending_high = None
            return chr(combined)
        self._pending_high = None
        return chr(cp)


# Tools whose "content" field is document HTML worth streaming live.
CONTENT_TOOLS = {
    "replace_content", "insert_at_end", "insert_at_cursor", "replace_selection",
    "replace_paragraph", "insert_after_paragraph", "insert_blockquote",
}


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _tool_call_to_operation(name: str, input_data: dict) -> dict:
    """Convert a tool call into a frontend operation dict."""
    if name == "format_selection":
        action = input_data.get("action")
        value = input_data.get("value")
        if action == "heading":
            return {"type": "set_heading", "level": int(value) if value else 1}
        elif action == "align":
            return {"type": "set_align", "alignment": value or "left"}
        elif action == "font_family":
            return {"type": "set_font_family", "family": value or "Arial"}
        elif action == "font_size":
            return {"type": "set_font_size", "size": value or "14pt"}
        elif action == "color":
            return {"type": "set_color", "color": value or "#000000"}
        else:
            return {"type": f"set_{action}"}
    elif name == "insert_table":
        return {"type": "insert_table", "rows": input_data.get("rows", 3), "cols": input_data.get("cols", 3)}
    elif name == "insert_list":
        return {"type": "insert_list", "list_type": input_data.get("list_type", "unordered"), "items": input_data.get("items", [])}
    elif name == "insert_horizontal_rule":
        return {"type": "insert_horizontal_rule"}
    elif name == "insert_code_block":
        return {"type": "insert_code_block", "content": input_data.get("content", ""), "language": input_data.get("language", "")}
    elif name == "set_link":
        return {"type": "set_link", "href": input_data.get("href", "")}
    else:
        # Direct mapping: replace_content, insert_at_cursor, insert_at_end, etc.
        op = {"type": name}
        op.update({k: v for k, v in input_data.items() if k not in ("requires_confirmation", "preview")})
        # Models occasionally emit paragraph_index as a string; coerce so the
        # frontend's numeric index lookup does not silently miss the block.
        if "paragraph_index" in op:
            coerced = _coerce_block_index(op["paragraph_index"])
            if coerced is not None:
                op["paragraph_index"] = coerced
        return op


def _build_result(reply_text: str, raw_tool_calls: list,
                  doc_view: DocumentView | None = None, extra_warnings: list | None = None) -> dict:
    """Convert accumulated tool calls into operations, dropping any whose JSON
    is broken (usually a truncated stream) instead of applying empty content.

    Hard safety rails (the prompt asks nicely; this enforces):
    - replace_content on a document too long to show in full is discarded.
    - replace_paragraph on a block the model never fully read is discarded.
    """
    operations = []
    requires_confirmation = False
    preview = None
    warnings = list(extra_warnings or [])

    for tc in raw_tool_calls:
        name = tc["name"]
        if name == "read_blocks":
            continue  # server-side only, already executed during the agent loop
        raw = tc["arguments"]
        try:
            input_data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            warnings.append(
                f"The '{name}' operation was cut off before it finished and has been discarded to protect your document."
            )
            continue
        if name == "replace_content":
            if not (input_data.get("content") or "").strip():
                warnings.append("A full-document rewrite arrived empty and was discarded to protect your document.")
                continue
            if doc_view is not None and doc_view.has_unseen_blocks():
                warnings.append(
                    "A full-document rewrite was blocked: this document is too long to rewrite "
                    "in one pass without losing content. The AI should edit it section by section."
                )
                continue
        if name == "replace_paragraph" and doc_view is not None and doc_view.blocks:
            idx = _coerce_block_index(input_data.get("paragraph_index"))
            if idx is not None and 0 <= idx < len(doc_view.blocks) and idx not in doc_view.seen:
                warnings.append(
                    f"The edit to block {idx + 1} was discarded: its full content was never read, "
                    "so applying it could have lost text."
                )
                continue
        op = _tool_call_to_operation(name, input_data)
        operations.append(op)
        if input_data.get("requires_confirmation") or name in FORCE_CONFIRMATION_TOOLS:
            requires_confirmation = True
            preview = input_data.get("preview", preview)

    result = {"reply": reply_text or ("Done." if operations else ""), "operations": operations}
    if requires_confirmation:
        result["requires_confirmation"] = True
        result["preview"] = preview
    if warnings:
        result["warnings"] = warnings
    return result


def _has_edits(calls: list) -> bool:
    """True if any call is a document edit (read_blocks is server-side only)."""
    return any(c.get("name") and c["name"] != "read_blocks" for c in calls)


def _has_full_rewrite(collected: list) -> bool:
    return any(c.get("name") == "replace_content" for c in collected)


def _parse_tool_args(call: dict) -> dict:
    """Normalize a collected tool call to a parsed argument dict."""
    if isinstance(call.get("input"), dict):
        return call["input"]
    raw = call.get("arguments") or ""
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {}


def _coerce_block_index(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        value = value.strip()
        if value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
            return int(value)
    return None


_HEADING_TEXT_RE = re.compile(
    r"^\s*(?:"
    r"第[零一二三四五六七八九十百千\d]+[章节部篇回]"
    r"|[（(][零一二三四五六七八九十\d]+[）)]"
    r"|[一二三四五六七八九十]+[、.．]"
    r"|\d+(?:\.\d+){0,3}(?:\s|$)"
    r"|Chapter\s+\d+"
    r"|Section\s+\d+"
    r")",
    re.IGNORECASE,
)

_WHOLE_DOC_TASK_RE = re.compile(
    r"排版|格式化|加标题|标题层级|美化|全文|整篇|整个文档|全部标题|所有标题|"
    r"\bformat\b|\bbeautify\b|restructur|headings?|all\s+heading|"
    r"whole\s+doc|entire\s+doc|whole\s+document",
    re.IGNORECASE,
)


def _looks_like_heading_block(html: str) -> bool:
    """True if a block is already a heading tag or its text looks like one."""
    m = _BLOCK_TAG_RE.match(html or "")
    tag = m.group(1).lower() if m else ""
    if tag in ("h1", "h2", "h3", "h4"):
        return True
    text = _STRIP_TAGS_RE.sub("", html or "")
    text = re.sub(r"\s+", " ", text).strip()
    if not text or len(text) > 80:
        return False
    return bool(_HEADING_TEXT_RE.match(text))


def _edited_block_indices(collected: list) -> set[int]:
    indices: set[int] = set()
    for c in collected:
        name = c.get("name")
        if name not in {
            "replace_paragraph", "delete_paragraph", "insert_after_paragraph",
            "set_heading",
        }:
            continue
        idx = _coerce_block_index(_parse_tool_args(c).get("paragraph_index"))
        if idx is not None:
            indices.add(idx)
    return indices


def _coverage_gaps(user_message: str, doc_view: "DocumentView", collected: list) -> list[int]:
    """Heading-like blocks the instruction likely covers but that have no edit yet.

    Used to stop the common failure mode where the model formats the first
    heading, writes a confident summary, and stops.
    """
    if not doc_view.blocks or not _has_edits(collected) or _has_full_rewrite(collected):
        return []
    candidates = [i for i, b in enumerate(doc_view.blocks) if _looks_like_heading_block(b)]
    if not candidates:
        return []
    edited = _edited_block_indices(collected)
    gaps = [i for i in candidates if i not in edited]
    if not gaps:
        return []
    is_whole = bool(_WHOLE_DOC_TASK_RE.search(user_message or ""))
    touched_candidates = bool(edited & set(candidates))
    # Enforce when the user asked for a whole-doc format pass, OR when the
    # model already started editing heading-like blocks (partial pass).
    if is_whole or touched_candidates:
        return gaps
    return []


def _format_missing(gaps: list[int], limit: int = 40) -> str:
    shown = ", ".join(f"[{i}]" for i in gaps[:limit])
    if len(gaps) > limit:
        shown += f" (and {len(gaps) - limit} more)"
    return shown


def _next_check_nudge(
    user_message: str,
    doc_view: "DocumentView",
    collected: list,
    round_had_edits: bool,
    checks_used: int,
) -> str | None:
    """Return a checkpoint/hard-coverage nudge, or None when the loop may stop.

    Rules:
    - After a round that queued edits: verify at least once; if concrete gaps
      are known, list them so the model cannot hand-wave.
    - Known coverage gaps always keep the loop going (hard nudge), even after
      MAX_CHECK_NUDGES soft checks — otherwise a long one-edit-per-round pass
      gets cut off mid-document. MAX_AGENT_ROUNDS is the real ceiling.
    - A text-only confirmation with no gaps ends the task.
    """
    if not _has_edits(collected):
        return None
    gaps = _coverage_gaps(user_message, doc_view, collected)
    n = len([c for c in collected if c.get("name") != "read_blocks"])
    last = max(len(doc_view.blocks) - 1, 0)

    if round_had_edits:
        if gaps:
            # Soft budget exhausted → keep driving with an explicit missing list.
            if checks_used >= MAX_CHECK_NUDGES:
                return HARD_CHECK_NUDGE.format(missing=_format_missing(gaps))
            gap_clause = (
                f"Coverage is INCOMPLETE: these heading-like blocks have no queued "
                f"edit yet: {_format_missing(gaps)}. Emit replace_paragraph for EACH "
                f"of them NOW. "
            )
            return CHECK_NUDGE.format(n=n, last=last, gap_clause=gap_clause)
        if checks_used == 0:
            gap_clause = (
                "Compare your queued edits against the user's instruction and the "
                "FULL block list: every block the instruction applies to must have "
                "a corresponding queued edit. If you skipped any covered block "
                "(e.g. you only edited the first headings), emit the missing edits NOW. "
            )
            return CHECK_NUDGE.format(n=n, last=last, gap_clause=gap_clause)
        return None

    # Text-only confirmation — never trust it while known gaps remain.
    if gaps:
        return HARD_CHECK_NUDGE.format(missing=_format_missing(gaps))
    return None


def _coverage_finish_warnings(user_message: str, doc_view: "DocumentView", collected: list) -> list[str]:
    gaps = _coverage_gaps(user_message, doc_view, collected)
    if not gaps:
        return []
    return [_COVERAGE_WARNING.format(count=len(gaps), missing=_format_missing(gaps, limit=20))]


def _partition_complete_calls(calls: list) -> tuple[list, list]:
    """Split raw tool calls ({name, arguments}) into (complete, broken) by JSON
    validity. The broken tail of a length-truncated response is dropped - the
    model re-emits it when we ask it to continue."""
    complete, broken = [], []
    for c in calls:
        if not c["name"]:
            broken.append(c)
            continue
        try:
            json.loads(c["arguments"]) if c["arguments"] else {}
            complete.append(c)
        except json.JSONDecodeError:
            broken.append(c)
    return complete, broken


def _queue_openai_round(messages: list, content, calls: list, doc_view: DocumentView):
    """Append one agent round to an OpenAI conversation: the assistant tool-call
    message plus a tool response per call (reads answered, edits acked).
    `calls` must all have valid JSON arguments."""
    if not calls:
        if content:
            messages.append({"role": "assistant", "content": content})
        return
    messages.append({
        "role": "assistant",
        "content": content or None,
        "tool_calls": [
            {"id": c["id"], "type": "function",
             "function": {"name": c["name"], "arguments": c["arguments"]}}
            for c in calls
        ],
    })
    for c in calls:
        result = doc_view.read_json(c["arguments"]) if c["name"] == "read_blocks" else QUEUED_EDIT_ACK
        messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})


def _queue_anthropic_round(messages: list, text: str, uses: list, doc_view: DocumentView, nudge: str | None = None):
    """Append one agent round to an Anthropic conversation: assistant message
    (text + tool_use blocks), then the user message with a tool_result per call
    (reads answered, edits acked), plus an optional continuation nudge.
    `uses`: [{id, name, input}]; input must be a parsed dict."""
    assistant_content = []
    if text:
        assistant_content.append({"type": "text", "text": text})
    for u in uses:
        assistant_content.append({"type": "tool_use", "id": u["id"], "name": u["name"], "input": u["input"]})
    if not assistant_content:
        # A truncated round can produce nothing at all; Anthropic requires
        # alternating roles, so keep the assistant turn non-empty.
        assistant_content.append({"type": "text", "text": "(Output cut off by the length limit.)"})
    messages.append({"role": "assistant", "content": assistant_content})
    user_content = []
    for u in uses:
        if u["name"] == "read_blocks":
            result = doc_view.read(u["input"].get("start_index"), u["input"].get("end_index"))
        else:
            result = QUEUED_EDIT_ACK
        user_content.append({"type": "tool_result", "tool_use_id": u["id"], "content": result})
    if nudge:
        user_content.append({"type": "text", "text": nudge})
    messages.append({"role": "user", "content": user_content})


def _init_openai_messages(message: str, doc_view: DocumentView, history: list, selection: str) -> list:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": doc_view.context_text(selection)},
    ]
    for h in history[-6:]:
        content = h.get("content", "")
        if content:
            messages.append({"role": h.get("role", "user"), "content": content})
    messages.append({"role": "user", "content": message})
    return messages


def _init_anthropic(message: str, doc_view: DocumentView, history: list, selection: str) -> tuple[str, list]:
    system = SYSTEM_PROMPT + "\n\n" + doc_view.context_text(selection)
    return system, _anthropic_messages(message, history)


def _anthropic_messages(message: str, history: list) -> list:
    messages = []
    for h in history[-6:]:
        role = h.get("role", "user")
        content = h.get("content", "")
        if not content:
            continue
        # Anthropic requires alternating roles; merge consecutive same-role messages
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] += "\n" + content
        else:
            messages.append({"role": role, "content": content})
    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"] += "\n" + message
    else:
        messages.append({"role": "user", "content": message})
    return messages


# ---------------------------------------------------------------------------
# Non-streaming chat (fallback path + connection test)
# ---------------------------------------------------------------------------

async def process_chat(message: str, document: str, history: list, provider: str = None, selection: str = "") -> dict:
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")

    if not api_key:
        return {
            "reply": "No API key configured. Click the key icon in the toolbar to set your OpenAI or Anthropic API key.",
            "operations": [],
        }

    if not provider:
        provider = "anthropic" if os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("OPENAI_API_KEY") else "openai"

    if provider == "openai":
        return await _openai_chat(message, document, history, selection)
    else:
        return await _anthropic_chat(message, document, history, selection)


async def _openai_chat(message: str, document: str, history: list, selection: str = "") -> dict:
    base_url = os.environ.get("OPENAI_BASE_URL") or None
    client = AsyncOpenAI(base_url=base_url) if base_url else AsyncOpenAI()

    doc_view = DocumentView(document)
    messages = _init_openai_messages(message, doc_view, history, selection)

    reply_text = ""
    collected = []
    rounds_exhausted = False
    checks_used = 0

    try:
        for _round in range(MAX_AGENT_ROUNDS):
            response = await client.chat.completions.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
                messages=messages,
                temperature=0.3,
                tools=OPENAI_TOOLS,
                max_tokens=MAX_TOKENS,
            )
            choice = response.choices[0]
            msg = choice.message
            truncated = choice.finish_reason == "length"
            if msg.content:
                reply_text += msg.content

            round_calls = []
            if msg.tool_calls:
                for tc in msg.tool_calls:
                    round_calls.append({
                        "id": tc.id or f"call_{_round}_{len(round_calls)}",
                        "name": tc.function.name,
                        "arguments": tc.function.arguments or "",
                    })

            # Treat broken trailing tool JSON like a length truncation — some
            # relays return finish_reason=stop even when the last tool call was cut off.
            valid, broken = _partition_complete_calls(round_calls)
            if truncated or broken:
                collected.extend([c for c in valid if c["name"] != "read_blocks"])
                _queue_openai_round(messages, msg.content, valid, doc_view)
                messages.append({"role": "user", "content": CONTINUATION_NUDGE})
                continue

            reads = [c for c in round_calls if c["name"] == "read_blocks"]
            collected.extend([c for c in round_calls if c["name"] != "read_blocks"])
            if reads:
                _queue_openai_round(messages, msg.content, round_calls, doc_view)
                continue

            nudge = _next_check_nudge(message, doc_view, collected, _has_edits(round_calls), checks_used)
            if nudge:
                checks_used += 1
                _queue_openai_round(messages, msg.content, round_calls, doc_view)
                messages.append({"role": "user", "content": nudge})
                continue
            break
        else:
            rounds_exhausted = True

        extra = ([_ROUNDS_EXHAUSTED_WARNING] if rounds_exhausted else [])
        extra.extend(_coverage_finish_warnings(message, doc_view, collected))
        return _build_result(reply_text, collected, doc_view=doc_view, extra_warnings=extra or None)
    except Exception as e:
        return {"reply": f"Error: {str(e)}", "operations": []}


async def _anthropic_chat(message: str, document: str, history: list, selection: str = "") -> dict:
    import anthropic

    base_url = os.environ.get("ANTHROPIC_BASE_URL") or None
    client = anthropic.AsyncAnthropic(base_url=base_url) if base_url else anthropic.AsyncAnthropic()

    doc_view = DocumentView(document)
    system, messages = _init_anthropic(message, doc_view, history, selection)

    reply_parts = []
    collected = []
    rounds_exhausted = False
    checks_used = 0

    try:
        for _round in range(MAX_AGENT_ROUNDS):
            response = await client.messages.create(
                model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
                max_tokens=MAX_TOKENS,
                system=system,
                messages=messages,
                tools=ANTHROPIC_TOOLS,
            )
            truncated = response.stop_reason == "max_tokens"

            round_text = ""
            round_uses = []
            for block in response.content:
                if block.type == "text":
                    reply_parts.append(block.text)
                    round_text += block.text
                elif block.type == "tool_use":
                    round_uses.append({"id": block.id, "name": block.name, "input": block.input})

            if truncated:
                # Output limit cut the response off mid-task: queue the intact
                # calls and let the model continue in this same conversation
                # (see _openai_chat).
                collected.extend(
                    {"name": u["name"], "arguments": json.dumps(u["input"], ensure_ascii=False)}
                    for u in round_uses if u["name"] != "read_blocks"
                )
                _queue_anthropic_round(messages, round_text, round_uses, doc_view, nudge=CONTINUATION_NUDGE)
                continue

            reads = [u for u in round_uses if u["name"] == "read_blocks"]
            collected.extend(
                {"name": u["name"], "arguments": json.dumps(u["input"], ensure_ascii=False)}
                for u in round_uses if u["name"] != "read_blocks"
            )
            if reads:
                _queue_anthropic_round(messages, round_text, round_uses, doc_view)
                continue

            nudge = _next_check_nudge(
                message, doc_view, collected, _has_edits(round_uses), checks_used,
            )
            if nudge:
                checks_used += 1
                _queue_anthropic_round(messages, round_text, round_uses, doc_view, nudge=nudge)
                continue
            break
        else:
            rounds_exhausted = True

        extra = ([_ROUNDS_EXHAUSTED_WARNING] if rounds_exhausted else [])
        extra.extend(_coverage_finish_warnings(message, doc_view, collected))
        return _build_result("\n".join(reply_parts), collected, doc_view=doc_view, extra_warnings=extra or None)
    except Exception as e:
        return {"reply": f"Error: {str(e)}", "operations": []}


# ---------------------------------------------------------------------------
# Streaming chat: emits granular SSE events so the UI can show live activity
# (reading / thinking / writing) and render document content as it is written.
#
# Event types:
#   status        {stage}                     - reading | thinking
#   chunk         {content}                   - assistant reply text delta
#   thinking      {content}                   - model reasoning delta (if any)
#   tool_start    {name, index}               - a tool call began
#   tool_delta    {name, index, content}      - decoded document text/HTML delta
#   tool_progress {name, index, chars}        - raw argument size so far
#   done          {result}                    - final reply + operations
#   error         {content}
# ---------------------------------------------------------------------------

async def process_chat_stream(message: str, document: str, history: list, provider: str = None, selection: str = "") -> AsyncGenerator[str, None]:
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")

    if not api_key:
        yield _sse({"type": "error", "content": "No API key configured. Click the key icon in the toolbar to set your API key."})
        return

    if not provider:
        provider = "anthropic" if os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("OPENAI_API_KEY") else "openai"

    if provider == "openai":
        async for chunk in _openai_stream(message, document, history, selection):
            yield chunk
    else:
        async for chunk in _anthropic_stream(message, document, history, selection):
            yield chunk


async def _openai_stream(message: str, document: str, history: list, selection: str = "") -> AsyncGenerator[str, None]:
    base_url = os.environ.get("OPENAI_BASE_URL") or None
    client = AsyncOpenAI(base_url=base_url) if base_url else AsyncOpenAI()

    yield _sse({"type": "status", "stage": "reading"})

    doc_view = DocumentView(document)
    messages = _init_openai_messages(message, doc_view, history, selection)

    reply_text = ""
    collected = []  # edit ops accumulated across rounds (read_blocks excluded)
    rounds_exhausted = False
    checks_used = 0
    event_index_base = 0  # keeps streamed tool indices unique across rounds

    try:
        for _round in range(MAX_AGENT_ROUNDS):
            stream = await client.chat.completions.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
                messages=messages,
                temperature=0.3,
                tools=OPENAI_TOOLS,
                max_tokens=MAX_TOKENS,
                stream=True,
            )
            yield _sse({"type": "status", "stage": "thinking"})

            round_tools: dict = {}  # index -> {id, name, arguments, extractor, last_progress}
            round_reply = ""
            truncated = False

            async for chunk in stream:
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                if choice.finish_reason == "length":
                    truncated = True
                delta = choice.delta
                if delta is None:
                    continue

                # Some providers expose reasoning tokens; surface them as activity.
                reasoning = getattr(delta, "reasoning_content", None)
                if reasoning:
                    yield _sse({"type": "thinking", "content": reasoning})

                if delta.content:
                    round_reply += delta.content
                    reply_text += delta.content
                    yield _sse({"type": "chunk", "content": delta.content})

                if delta.tool_calls:
                    for tc_delta in delta.tool_calls:
                        idx = tc_delta.index
                        if idx not in round_tools:
                            round_tools[idx] = {"id": "", "name": "", "arguments": "", "extractor": ContentFieldExtractor(), "last_progress": 0}
                        entry = round_tools[idx]
                        if tc_delta.id:
                            entry["id"] = tc_delta.id
                        if tc_delta.function.name:
                            if not entry["name"]:
                                entry["name"] = tc_delta.function.name
                                yield _sse({"type": "tool_start", "name": entry["name"], "index": event_index_base + idx})
                        if tc_delta.function.arguments:
                            entry["arguments"] += tc_delta.function.arguments
                            if entry["name"] in CONTENT_TOOLS:
                                text = entry["extractor"].feed(tc_delta.function.arguments)
                                if text:
                                    yield _sse({"type": "tool_delta", "name": entry["name"], "index": event_index_base + idx, "content": text})
                            if len(entry["arguments"]) - entry["last_progress"] >= 800:
                                entry["last_progress"] = len(entry["arguments"])
                                yield _sse({"type": "tool_progress", "name": entry["name"], "index": event_index_base + idx, "chars": len(entry["arguments"])})

            round_list = [round_tools[i] for i in sorted(round_tools)]
            event_index_base += len(round_list)

            # Broken trailing tool JSON (common with API relays) is treated like
            # finish_reason=length so the model re-emits the cut-off call.
            valid, broken = _partition_complete_calls(round_list)
            if truncated or broken:
                for i, c in enumerate(valid):
                    if not c["id"]:
                        c["id"] = f"call_{_round}_{i}"
                collected.extend([c for c in valid if c["name"] != "read_blocks"])
                _queue_openai_round(messages, round_reply, valid, doc_view)
                messages.append({"role": "user", "content": CONTINUATION_NUDGE})
                continue

            reads = [c for c in round_list if c["name"] == "read_blocks"]
            collected.extend([c for c in round_list if c["name"] != "read_blocks"])
            for i, c in enumerate(round_list):
                if not c["id"]:
                    c["id"] = f"call_{_round}_{i}"

            if reads:
                _queue_openai_round(messages, round_reply, round_list, doc_view)
                continue

            nudge = _next_check_nudge(message, doc_view, collected, _has_edits(round_list), checks_used)
            if nudge:
                checks_used += 1
                _queue_openai_round(messages, round_reply, round_list, doc_view)
                messages.append({"role": "user", "content": nudge})
                yield _sse({"type": "status", "stage": "checking"})
                continue
            break
        else:
            rounds_exhausted = True

        raw_tool_calls = [{"name": c["name"], "arguments": c["arguments"]} for c in collected]
        extra = ([_ROUNDS_EXHAUSTED_WARNING] if rounds_exhausted else [])
        extra.extend(_coverage_finish_warnings(message, doc_view, collected))
        result = _build_result(reply_text, raw_tool_calls, doc_view=doc_view, extra_warnings=extra or None)
        yield _sse({"type": "done", "result": result})
    except Exception as e:
        yield _sse({"type": "error", "content": str(e)})


async def _anthropic_stream(message: str, document: str, history: list, selection: str = "") -> AsyncGenerator[str, None]:
    """Stream Anthropic responses with native tool-calling support."""
    import anthropic

    base_url = os.environ.get("ANTHROPIC_BASE_URL") or None
    client = anthropic.AsyncAnthropic(base_url=base_url) if base_url else anthropic.AsyncAnthropic()

    yield _sse({"type": "status", "stage": "reading"})

    doc_view = DocumentView(document)
    system, messages = _init_anthropic(message, doc_view, history, selection)

    reply_text = ""
    collected = []  # edit ops accumulated across rounds (read_blocks excluded)
    rounds_exhausted = False
    checks_used = 0
    tool_index = 0  # keeps streamed tool indices unique across rounds

    try:
        for _round in range(MAX_AGENT_ROUNDS):
            # Use the raw streaming API instead of the `messages.stream()` helper:
            # the helper enforces strict SSE event ordering (message_start first),
            # which breaks with API relays/proxies that emit non-standard streams.
            stream = await client.messages.create(
                model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
                max_tokens=MAX_TOKENS,
                system=system,
                messages=messages,
                tools=ANTHROPIC_TOOLS,
                stream=True,
            )
            yield _sse({"type": "status", "stage": "thinking"})

            round_text = ""
            round_uses = []  # list of {id, name, arguments}
            current = None  # {id, name, arguments, extractor, last_progress, index}
            truncated = False

            async for event in stream:
                etype = getattr(event, "type", "")
                if etype == "content_block_start":
                    if event.content_block.type == "tool_use":
                        current = {"id": event.content_block.id, "name": event.content_block.name, "arguments": "", "extractor": ContentFieldExtractor(), "last_progress": 0, "index": tool_index}
                        tool_index += 1
                        yield _sse({"type": "tool_start", "name": current["name"], "index": current["index"]})
                elif etype == "content_block_delta":
                    dtype = getattr(event.delta, "type", "")
                    if dtype == "text_delta":
                        round_text += event.delta.text
                        reply_text += event.delta.text
                        yield _sse({"type": "chunk", "content": event.delta.text})
                    elif dtype == "thinking_delta":
                        yield _sse({"type": "thinking", "content": getattr(event.delta, "thinking", "")})
                    elif dtype == "input_json_delta" and current is not None:
                        partial = event.delta.partial_json
                        current["arguments"] += partial
                        if current["name"] in CONTENT_TOOLS:
                            text = current["extractor"].feed(partial)
                            if text:
                                yield _sse({"type": "tool_delta", "name": current["name"], "index": current["index"], "content": text})
                        if len(current["arguments"]) - current["last_progress"] >= 800:
                            current["last_progress"] = len(current["arguments"])
                            yield _sse({"type": "tool_progress", "name": current["name"], "index": current["index"], "chars": len(current["arguments"])})
                elif etype == "content_block_stop":
                    if current is not None:
                        round_uses.append(current)
                        current = None
                elif etype == "message_delta":
                    sr = getattr(getattr(event, "delta", None), "stop_reason", None)
                    if sr == "max_tokens":
                        truncated = True

            if current is not None:
                round_uses.append(current)

            # Partition by JSON validity; treat a broken tail like max_tokens even
            # when the provider reports a normal stop reason.
            valid, broken = [], []
            for u in round_uses:
                try:
                    u["input"] = json.loads(u["arguments"]) if u["arguments"] else {}
                    valid.append(u)
                except json.JSONDecodeError:
                    broken.append(u)

            if truncated or broken:
                collected.extend(
                    {"name": u["name"], "arguments": u["arguments"]}
                    for u in valid if u["name"] != "read_blocks"
                )
                _queue_anthropic_round(messages, round_text, valid, doc_view, nudge=CONTINUATION_NUDGE)
                continue

            reads = [u for u in valid if u["name"] == "read_blocks"]
            collected.extend(
                {"name": u["name"], "arguments": u["arguments"]}
                for u in valid if u["name"] != "read_blocks"
            )

            if reads:
                _queue_anthropic_round(messages, round_text, valid, doc_view)
                continue

            nudge = _next_check_nudge(
                message, doc_view, collected, _has_edits(valid), checks_used,
            )
            if nudge:
                checks_used += 1
                _queue_anthropic_round(messages, round_text, valid, doc_view, nudge=nudge)
                yield _sse({"type": "status", "stage": "checking"})
                continue
            break
        else:
            rounds_exhausted = True

        raw_tool_calls = [{"name": c["name"], "arguments": c["arguments"]} for c in collected]
        extra = ([_ROUNDS_EXHAUSTED_WARNING] if rounds_exhausted else [])
        extra.extend(_coverage_finish_warnings(message, doc_view, collected))
        result = _build_result(reply_text, raw_tool_calls, doc_view=doc_view, extra_warnings=extra or None)
        yield _sse({"type": "done", "result": result})

    except Exception as e:
        yield _sse({"type": "error", "content": str(e)})
