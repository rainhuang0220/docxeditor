import os
import json
from typing import AsyncGenerator
from openai import AsyncOpenAI

SYSTEM_PROMPT = """You are an AI document editing assistant inside a Word-like IDE.
You help users edit, format, and generate professional documents.

When you need to make changes to the document, use the available tools.
When answering questions or providing explanations, respond with plain text only.

## Tool Selection Guide
- If the user has selected text and asks to rewrite/improve/change it, use `replace_selection`
- For small targeted edits to a specific paragraph, use `replace_paragraph`
- For adding new content after a paragraph, use `insert_after_paragraph`
- For appending content at the end, use `insert_at_end`
- For full document rewrites or generating from scratch, use `replace_content`
- For formatting changes (bold, alignment, font), use `format_selection`

## Behavior Rules

### Auto-execute (no confirmation needed):
- Simple formatting: bold, italic, alignment, font changes
- Small insertions (a sentence, a heading, a list)
- Direct answers to questions about the document

### Requires confirmation (set requires_confirmation=true in tool input):
- Rewriting or replacing existing content
- Deleting content
- Restructuring the document
- Generating large amounts of new content
- Any change that alters meaning

### Clarification:
If the request is ambiguous, ask clarifying questions in text. Do NOT guess.

## HTML Content Rules
- Use semantic HTML: <h1>, <h2>, <p>, <strong>, <em>, <table>, <ul>, <ol>
- Use inline styles for formatting: style="text-align: center; font-family: Arial;"
- Generate complete, well-formed HTML fragments
"""

ANTHROPIC_TOOLS = [
    {
        "name": "replace_content",
        "description": "Replace the entire document with new HTML content. Use for full rewrites or generating a complete new document.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Complete HTML content for the document"},
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
        "name": "insert_after_paragraph",
        "description": "Insert HTML content after a specific paragraph (0-indexed).",
        "input_schema": {
            "type": "object",
            "properties": {
                "paragraph_index": {"type": "integer", "description": "0-based index of the paragraph to insert after"},
                "content": {"type": "string", "description": "HTML content to insert"}
            },
            "required": ["paragraph_index", "content"]
        }
    },
    {
        "name": "replace_paragraph",
        "description": "Replace a specific paragraph's content (0-indexed).",
        "input_schema": {
            "type": "object",
            "properties": {
                "paragraph_index": {"type": "integer", "description": "0-based index of the paragraph to replace"},
                "content": {"type": "string", "description": "New HTML content for the paragraph"},
                "requires_confirmation": {"type": "boolean", "default": True},
                "preview": {"type": "string", "description": "Brief summary of what changes"}
            },
            "required": ["paragraph_index", "content"]
        }
    },
    {
        "name": "delete_paragraph",
        "description": "Delete a specific paragraph by index (0-indexed).",
        "input_schema": {
            "type": "object",
            "properties": {
                "paragraph_index": {"type": "integer", "description": "0-based index of the paragraph to delete"},
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
                "value": {"type": "string", "description": "Value for the action (e.g., heading level '1'-'3', alignment 'center', font name, size '14pt', color '#ff0000')"}
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



def _tool_call_to_operation(name: str, input_data: dict) -> dict:
    """Convert an Anthropic tool call into a frontend operation dict."""
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
        return op


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
    client = AsyncOpenAI()

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if document:
        messages.append({"role": "system", "content": f"Current document HTML:\n{document[:4000]}"})
    if selection:
        messages.append({"role": "system", "content": f"Currently selected text:\n{selection[:1000]}"})
    for h in history[-6:]:
        messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
    messages.append({"role": "user", "content": message})

    try:
        response = await client.chat.completions.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
            messages=messages,
            temperature=0.3,
            tools=OPENAI_TOOLS,
        )
        msg = response.choices[0].message

        reply_parts = []
        operations = []
        requires_confirmation = False
        preview = None

        if msg.content:
            reply_parts.append(msg.content)

        if msg.tool_calls:
            for tc in msg.tool_calls:
                try:
                    input_data = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    input_data = {}
                op = _tool_call_to_operation(tc.function.name, input_data)
                operations.append(op)
                if input_data.get("requires_confirmation"):
                    requires_confirmation = True
                    preview = input_data.get("preview", preview)

        reply = "\n".join(reply_parts) if reply_parts else ("Done." if operations else "")
        result = {"reply": reply, "operations": operations}
        if requires_confirmation:
            result["requires_confirmation"] = True
            result["preview"] = preview
        return result
    except Exception as e:
        return {"reply": f"Error: {str(e)}", "operations": []}


async def _anthropic_chat(message: str, document: str, history: list, selection: str = "") -> dict:
    import anthropic

    client = anthropic.AsyncAnthropic()

    system = SYSTEM_PROMPT
    if document:
        system += f"\n\nCurrent document HTML:\n{document[:4000]}"
    if selection:
        system += f"\n\nCurrently selected text:\n{selection[:1000]}"

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
    # Ensure the final user message is appended correctly
    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"] += "\n" + message
    else:
        messages.append({"role": "user", "content": message})

    try:
        response = await client.messages.create(
            model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
            max_tokens=4096,
            system=system,
            messages=messages,
            tools=ANTHROPIC_TOOLS,
        )

        # Parse response: extract text blocks and tool_use blocks
        reply_parts = []
        operations = []
        requires_confirmation = False
        preview = None

        for block in response.content:
            if block.type == "text":
                reply_parts.append(block.text)
            elif block.type == "tool_use":
                input_data = block.input
                op = _tool_call_to_operation(block.name, input_data)
                operations.append(op)
                if input_data.get("requires_confirmation"):
                    requires_confirmation = True
                    preview = input_data.get("preview", preview)

        reply = "\n".join(reply_parts) if reply_parts else ("Done." if operations else "")
        result = {"reply": reply, "operations": operations}
        if requires_confirmation:
            result["requires_confirmation"] = True
            result["preview"] = preview
        return result

    except Exception as e:
        return {"reply": f"Error: {str(e)}", "operations": []}


async def process_chat_stream(message: str, document: str, history: list, provider: str = None, selection: str = "") -> AsyncGenerator[str, None]:
    """Stream AI responses as Server-Sent Events."""
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")

    if not api_key:
        yield f"data: {json.dumps({'type': 'error', 'content': 'No API key configured. Click the key icon in the toolbar to set your API key.'})}\n\n"
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
    client = AsyncOpenAI()

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if document:
        messages.append({"role": "system", "content": f"Current document HTML:\n{document[:4000]}"})
    if selection:
        messages.append({"role": "system", "content": f"Currently selected text:\n{selection[:1000]}"})
    for h in history[-6:]:
        messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
    messages.append({"role": "user", "content": message})

    try:
        stream = await client.chat.completions.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
            messages=messages,
            temperature=0.3,
            tools=OPENAI_TOOLS,
            stream=True,
        )
        reply_text = ""
        # Track tool calls being streamed
        tool_calls_map: dict = {}  # index -> {name, arguments}

        async for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                reply_text += delta.content
                yield f"data: {json.dumps({'type': 'chunk', 'content': delta.content})}\n\n"
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in tool_calls_map:
                        tool_calls_map[idx] = {"name": "", "arguments": ""}
                    if tc_delta.function.name:
                        tool_calls_map[idx]["name"] = tc_delta.function.name
                    if tc_delta.function.arguments:
                        tool_calls_map[idx]["arguments"] += tc_delta.function.arguments

        # Build final result from accumulated tool calls
        operations = []
        requires_confirmation = False
        preview = None

        for idx in sorted(tool_calls_map.keys()):
            tc = tool_calls_map[idx]
            try:
                input_data = json.loads(tc["arguments"]) if tc["arguments"] else {}
            except json.JSONDecodeError:
                input_data = {}
            op = _tool_call_to_operation(tc["name"], input_data)
            operations.append(op)
            if input_data.get("requires_confirmation"):
                requires_confirmation = True
                preview = input_data.get("preview", preview)

        result = {"reply": reply_text or ("Done." if operations else ""), "operations": operations}
        if requires_confirmation:
            result["requires_confirmation"] = True
            result["preview"] = preview

        yield f"data: {json.dumps({'type': 'done', 'result': result})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"


async def _anthropic_stream(message: str, document: str, history: list, selection: str = "") -> AsyncGenerator[str, None]:
    """Stream Anthropic responses with native tool-calling support."""
    import anthropic

    client = anthropic.AsyncAnthropic()

    system = SYSTEM_PROMPT
    if document:
        system += f"\n\nCurrent document HTML:\n{document[:4000]}"
    if selection:
        system += f"\n\nCurrently selected text:\n{selection[:1000]}"

    messages = []
    for h in history[-6:]:
        role = h.get("role", "user")
        content = h.get("content", "")
        if not content:
            continue
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] += "\n" + content
        else:
            messages.append({"role": role, "content": content})
    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"] += "\n" + message
    else:
        messages.append({"role": "user", "content": message})

    try:
        reply_text = ""
        tool_uses = []  # list of {name, input_json_str}
        current_tool_name = ""
        current_tool_input = ""

        async with client.messages.stream(
            model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
            max_tokens=4096,
            system=system,
            messages=messages,
            tools=ANTHROPIC_TOOLS,
        ) as stream:
            async for event in stream:
                if event.type == "content_block_start":
                    if event.content_block.type == "tool_use":
                        current_tool_name = event.content_block.name
                        current_tool_input = ""
                elif event.type == "content_block_delta":
                    if event.delta.type == "text_delta":
                        reply_text += event.delta.text
                        yield f"data: {json.dumps({'type': 'chunk', 'content': event.delta.text})}\n\n"
                    elif event.delta.type == "input_json_delta":
                        current_tool_input += event.delta.partial_json
                elif event.type == "content_block_stop":
                    if current_tool_name:
                        tool_uses.append({"name": current_tool_name, "input": current_tool_input})
                        current_tool_name = ""
                        current_tool_input = ""

        # Build final result
        operations = []
        requires_confirmation = False
        preview = None

        for tu in tool_uses:
            try:
                input_data = json.loads(tu["input"]) if tu["input"] else {}
            except json.JSONDecodeError:
                input_data = {}
            op = _tool_call_to_operation(tu["name"], input_data)
            operations.append(op)
            if input_data.get("requires_confirmation"):
                requires_confirmation = True
                preview = input_data.get("preview", preview)

        result = {"reply": reply_text or ("Done." if operations else ""), "operations": operations}
        if requires_confirmation:
            result["requires_confirmation"] = True
            result["preview"] = preview

        yield f"data: {json.dumps({'type': 'done', 'result': result})}\n\n"

    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
