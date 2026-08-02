"""Smoke tests for auto-continuation + hard coverage checkpoint (no real API calls)."""
import asyncio
import json
import sys
import types

from . import ai_service as ai


# ---------------------------------------------------------------------------
# Fake OpenAI client
# ---------------------------------------------------------------------------

class _FakeMsg:
    def __init__(self, content, tool_calls):
        self.content = content
        self.tool_calls = tool_calls


class _FakeChoice:
    def __init__(self, finish_reason, msg):
        self.finish_reason = finish_reason
        self.message = msg


class _FakeToolFn:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class _FakeToolCall:
    def __init__(self, i, name, arguments):
        self.id = f"call_{i}"
        self.function = _FakeToolFn(name, arguments)


class _FakeResponse:
    def __init__(self, finish_reason, msg):
        self.choices = [_FakeChoice(finish_reason, msg)]


class FakeCompletions:
    """Round 1: truncated (length) with 2 valid edits + 1 cut-off edit.
    Round 2: normal stop with 1 edit → soft checkpoint (no gaps for plain <p>).
    Round 3: text-only confirmation → stop.
    Must produce 3 ops total."""

    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        round_no = len(self.calls)
        if round_no == 1:
            return _FakeResponse("length", _FakeMsg("Working on it.", [
                _FakeToolCall(0, "replace_paragraph", json.dumps({"paragraph_index": 0, "content": "<h1>A</h1>"})),
                _FakeToolCall(1, "replace_paragraph", json.dumps({"paragraph_index": 1, "content": "<p>B</p>"})),
                _FakeToolCall(2, "replace_paragraph", '{"paragraph_index": 2, "content": "<p>CUT OFF'),  # broken JSON
            ]))
        if round_no == 2:
            last = kwargs["messages"][-1]
            assert last["role"] == "user" and "cut off" in last["content"], f"no nudge: {last}"
            assistant = kwargs["messages"][-4]
            assert assistant["role"] == "assistant" and len(assistant["tool_calls"]) == 2, assistant
            return _FakeResponse("stop", _FakeMsg("Done.", [
                _FakeToolCall(0, "replace_paragraph", json.dumps({"paragraph_index": 2, "content": "<p>C</p>"})),
            ]))
        if round_no == 3:
            # Soft checkpoint after the edit round
            last = kwargs["messages"][-1]
            assert last["role"] == "user" and "Checkpoint" in last["content"], f"no checkpoint: {last}"
            return _FakeResponse("stop", _FakeMsg("All blocks covered.", []))
        raise AssertionError(f"unexpected round {round_no}")


class FakeOpenAIClient:
    def __init__(self):
        self.chat = types.SimpleNamespace(completions=FakeCompletions())


async def test_openai_continuation():
    fake = FakeOpenAIClient()
    orig = ai.AsyncOpenAI
    ai.AsyncOpenAI = lambda *a, **k: fake
    try:
        doc = "<p>one</p><p>two</p><p>three</p>"
        result = await ai._openai_chat("format everything", doc, [])
    finally:
        ai.AsyncOpenAI = orig
    ops = result["operations"]
    assert len(ops) == 3, f"expected 3 ops, got {len(ops)}: {ops}"
    assert [o["paragraph_index"] for o in ops] == [0, 1, 2], ops
    assert not result.get("warnings"), f"unexpected warnings: {result.get('warnings')}"
    assert len(fake.chat.completions.calls) == 3
    print("PASS: openai continuation - truncated round auto-continued, checkpointed, 3 ops")


# ---------------------------------------------------------------------------
# Fake Anthropic client
# ---------------------------------------------------------------------------

class _ABlock:
    def __init__(self, type_, **kw):
        self.type = type_
        for k, v in kw.items():
            setattr(self, k, v)


class _AResponse:
    def __init__(self, stop_reason, content):
        self.stop_reason = stop_reason
        self.content = content


class FakeAMessages:
    """Round 1: max_tokens with 1 valid edit.
    Round 2: end_turn with 1 edit → soft checkpoint.
    Round 3: text-only confirmation → stop."""

    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        round_no = len(self.calls)
        if round_no == 1:
            return _AResponse("max_tokens", [
                _ABlock("text", text="Formatting."),
                _ABlock("tool_use", id="tu_1", name="replace_paragraph",
                        input={"paragraph_index": 0, "content": "<h1>A</h1>"}),
            ])
        if round_no == 2:
            user = kwargs["messages"][-1]
            assert user["role"] == "user", user
            kinds = [b["type"] for b in user["content"]]
            assert kinds == ["tool_result", "text"], f"expected tool_result + nudge, got {kinds}"
            assert "cut off" in user["content"][1]["text"]
            return _AResponse("end_turn", [
                _ABlock("text", text="Done."),
                _ABlock("tool_use", id="tu_2", name="replace_paragraph",
                        input={"paragraph_index": 1, "content": "<p>B</p>"}),
            ])
        if round_no == 3:
            user = kwargs["messages"][-1]
            assert any(
                b.get("type") == "text" and "Checkpoint" in b.get("text", "")
                for b in user["content"]
            ), user
            return _AResponse("end_turn", [
                _ABlock("text", text="All done."),
            ])
        raise AssertionError(f"unexpected round {round_no}")


async def test_anthropic_continuation():
    fake_client = types.SimpleNamespace(messages=FakeAMessages())
    fake_module = types.SimpleNamespace(AsyncAnthropic=lambda *a, **k: fake_client)
    sys.modules["anthropic"] = fake_module
    try:
        doc = "<p>one</p><p>two</p>"
        result = await ai._anthropic_chat("format everything", doc, [])
    finally:
        sys.modules.pop("anthropic", None)
    ops = result["operations"]
    assert len(ops) == 2, f"expected 2 ops, got {len(ops)}: {ops}"
    assert not result.get("warnings"), f"unexpected warnings: {result.get('warnings')}"
    print("PASS: anthropic continuation - truncated + checkpoint, 2 ops collected")


# ---------------------------------------------------------------------------
# Hard coverage: model stops after first heading → forced to continue
# ---------------------------------------------------------------------------

class FakeCoverageCompletions:
    """Simulates the reported bug: formats only the first heading, claims done.
    The hard coverage nudge must force another edit round for remaining headings."""

    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        round_no = len(self.calls)
        if round_no == 1:
            # Only edit the first chapter heading
            return _FakeResponse("stop", _FakeMsg("我将按要求排版全文。", [
                _FakeToolCall(0, "replace_paragraph", json.dumps({
                    "paragraph_index": 0, "content": "<h1>第一章 绪论</h1>",
                })),
            ]))
        if round_no == 2:
            # Soft checkpoint after edits — must list missing heading-like blocks
            last = kwargs["messages"][-1]["content"]
            assert "Checkpoint" in last, last
            assert "[2]" in last and "[4]" in last, f"gaps not listed: {last}"
            # Lazy model confirms done without fixing
            return _FakeResponse("stop", _FakeMsg("已完成全部排版。", []))
        if round_no == 3:
            # Hard coverage nudge after the false confirmation
            last = kwargs["messages"][-1]["content"]
            assert "coverage check FAILED" in last, last
            assert "[2]" in last and "[4]" in last, last
            return _FakeResponse("stop", _FakeMsg("继续修改剩余标题。", [
                _FakeToolCall(0, "replace_paragraph", json.dumps({
                    "paragraph_index": 2, "content": "<h1>第二章 方法</h1>",
                })),
                _FakeToolCall(1, "replace_paragraph", json.dumps({
                    "paragraph_index": 4, "content": "<h2>2.1 细节</h2>",
                })),
            ]))
        raise AssertionError(f"unexpected round {round_no}")


async def test_hard_coverage_keeps_going():
    fake = FakeOpenAIClient()
    fake.chat.completions = FakeCoverageCompletions()
    orig = ai.AsyncOpenAI
    ai.AsyncOpenAI = lambda *a, **k: fake
    try:
        doc = (
            "<p>第一章 绪论</p>"
            "<p>介绍背景。</p>"
            "<p>第二章 方法</p>"
            "<p>方法正文。</p>"
            "<p>2.1 细节</p>"
            "<p>细节正文。</p>"
        )
        result = await ai._openai_chat("请按照规范排版当前文档，给所有章节加标题", doc, [])
    finally:
        ai.AsyncOpenAI = orig
    ops = result["operations"]
    idxs = sorted(o["paragraph_index"] for o in ops)
    assert idxs == [0, 2, 4], f"expected headings 0,2,4 edited, got {idxs}: {ops}"
    # 1) partial edit → 2) false done → 3) hard nudge fills gaps → stop (no extra
    # confirmation round once coverage is complete).
    assert len(fake.chat.completions.calls) == 3, len(fake.chat.completions.calls)
    assert not result.get("warnings"), result.get("warnings")
    print("PASS: hard coverage - false 'done' after first heading forced continuation")


class FakeBrokenJsonCompletions:
    """finish_reason=stop but last tool JSON is truncated — must auto-continue."""

    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        round_no = len(self.calls)
        if round_no == 1:
            return _FakeResponse("stop", _FakeMsg("Working.", [
                _FakeToolCall(0, "replace_paragraph", json.dumps({
                    "paragraph_index": 0, "content": "<h1>A</h1>",
                })),
                _FakeToolCall(1, "replace_paragraph", '{"paragraph_index": 1, "content": "<p>CUT'),
            ]))
        if round_no == 2:
            last = kwargs["messages"][-1]
            assert last["role"] == "user" and "cut off" in last["content"], last
            return _FakeResponse("stop", _FakeMsg("Fixed.", [
                _FakeToolCall(0, "replace_paragraph", json.dumps({
                    "paragraph_index": 1, "content": "<p>B</p>",
                })),
            ]))
        if round_no == 3:
            # soft checkpoint then confirm
            return _FakeResponse("stop", _FakeMsg("All covered.", []))
        raise AssertionError(f"unexpected round {round_no}")


async def test_broken_json_triggers_continuation():
    fake = FakeOpenAIClient()
    fake.chat.completions = FakeBrokenJsonCompletions()
    orig = ai.AsyncOpenAI
    ai.AsyncOpenAI = lambda *a, **k: fake
    try:
        result = await ai._openai_chat("format", "<p>one</p><p>two</p>", [])
    finally:
        ai.AsyncOpenAI = orig
    ops = result["operations"]
    assert [o["paragraph_index"] for o in ops] == [0, 1], ops
    assert len(fake.chat.completions.calls) >= 2
    print("PASS: broken tool JSON without finish_reason=length still continues")


class FakeCheckBudgetCompletions:
    """One heading edit per round past MAX_CHECK_NUDGES — must keep going."""

    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        round_no = len(self.calls)
        # Doc has headings at 0,2,4,6 — emit one per edit round after checks.
        heading_rounds = {
            1: 0,
            3: 2,
            5: 4,
            7: 6,
        }
        if round_no in heading_rounds:
            idx = heading_rounds[round_no]
            return _FakeResponse("stop", _FakeMsg(f"Edit {idx}", [
                _FakeToolCall(0, "replace_paragraph", json.dumps({
                    "paragraph_index": idx,
                    "content": f"<h1>H{idx}</h1>",
                })),
            ]))
        # Even rounds / after edits: false "done" confirmations
        if round_no in (2, 4, 6, 8):
            last = kwargs["messages"][-1]["content"]
            assert "Checkpoint" in last or "coverage check FAILED" in last, last
            if round_no < 8:
                return _FakeResponse("stop", _FakeMsg("已完成。", []))
            return _FakeResponse("stop", _FakeMsg("现在全部完成。", []))
        raise AssertionError(f"unexpected round {round_no}")


async def test_check_budget_does_not_abort_with_gaps():
    fake = FakeOpenAIClient()
    fake.chat.completions = FakeCheckBudgetCompletions()
    orig = ai.AsyncOpenAI
    ai.AsyncOpenAI = lambda *a, **k: fake
    try:
        doc = (
            "<p>第一章</p><p>a</p>"
            "<p>第二章</p><p>b</p>"
            "<p>第三章</p><p>c</p>"
            "<p>第四章</p><p>d</p>"
        )
        result = await ai._openai_chat("请排版全文标题", doc, [])
    finally:
        ai.AsyncOpenAI = orig
    idxs = sorted(o["paragraph_index"] for o in result["operations"])
    assert idxs == [0, 2, 4, 6], idxs
    print("PASS: check budget exhausted but gaps remain → loop keeps going")


def test_helpers():
    calls = [
        {"name": "replace_paragraph", "arguments": '{"paragraph_index": 1}'},
        {"name": "replace_paragraph", "arguments": '{"paragraph_index": 2, "co'},  # broken
        {"name": "", "arguments": ""},  # name never arrived
        {"name": "insert_at_end", "arguments": ""},  # empty args = valid
    ]
    complete, broken = ai._partition_complete_calls(calls)
    assert len(complete) == 2 and len(broken) == 2, (complete, broken)

    assert ai._coerce_block_index("3") == 3
    assert ai._coerce_block_index(3) == 3
    assert ai._looks_like_heading_block("<p>第一章 绪论</p>")
    assert ai._looks_like_heading_block("<p>2.1 细节</p>")
    assert not ai._looks_like_heading_block("<p>这是一段普通正文，不应该被当成标题。</p>")

    doc = ai.DocumentView(
        "<p>第一章 绪论</p><p>正文</p><p>第二章 方法</p><p>更多正文</p>"
    )
    collected = [{"name": "replace_paragraph", "arguments": json.dumps({
        "paragraph_index": 0, "content": "<h1>第一章 绪论</h1>",
    })}]
    gaps = ai._coverage_gaps("请排版全文标题", doc, collected)
    assert gaps == [2], gaps

    # String index must survive into the operation
    op = ai._tool_call_to_operation("replace_paragraph", {
        "paragraph_index": "5", "content": "<h1>X</h1>",
    })
    assert op["paragraph_index"] == 5, op

    print("PASS: helpers + coverage gap detection + index coercion")


if __name__ == "__main__":
    test_helpers()
    asyncio.run(test_openai_continuation())
    asyncio.run(test_anthropic_continuation())
    asyncio.run(test_hard_coverage_keeps_going())
    asyncio.run(test_broken_json_triggers_continuation())
    asyncio.run(test_check_budget_does_not_abort_with_gaps())
    print("ALL TESTS PASSED")
