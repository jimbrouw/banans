import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from roughcut_engine import edit
from roughcut_engine.app import app
from roughcut_engine.edit import EditError, Unit, ai_edit, build_prompt, call_claude, call_ollama, chunks, parse_reply, to_ranges

UNITS = [
    Unit(0, 0.0, 2.0, "Hey everyone, welcome back."),
    Unit(1, 2.5, 4.0, "Today we're talking about, today we're"),
    Unit(2, 4.2, 7.0, "Today we're talking about editing faster."),
    Unit(3, 7.5, 9.0, "Is this thing recording?"),
    Unit(4, 9.5, 12.0, "Let's get started."),
]


def test_build_prompt_numbers_lines_and_appends_instruction():
    prompt = build_prompt(UNITS[:2], "  keep the intro  ")
    assert prompt.splitlines()[1] == "[0] 00:00.0 Hey everyone, welcome back."
    assert prompt.splitlines()[2] == "[1] 00:02.5 Today we're talking about, today we're"
    assert prompt.endswith("Editor instruction: keep the intro")
    assert "Editor instruction" not in build_prompt(UNITS, "  ")


def test_parse_reply_handles_fences_and_rejects_garbage():
    assert parse_reply('```json\n{"remove": [], "keep": []}\n```') == {"remove": [], "keep": []}
    with pytest.raises(EditError, match="valid JSON"):
        parse_reply("Sure! Here are the cuts")


def test_to_ranges_merges_contiguous_ids_and_ignores_unknown():
    by_id = {u.id: u for u in UNITS}
    assert to_ranges([3, 1, 2, 99], by_id) == [(2.5, 9.0, [1, 2, 3])]
    assert to_ranges([0, 2], by_id) == [(0.0, 2.0, [0]), (4.2, 7.0, [2])]


def test_chunks_overlap(monkeypatch):
    monkeypatch.setattr(edit, "CHUNK_LINES", 4)
    monkeypatch.setattr(edit, "CHUNK_OVERLAP", 1)
    units = [Unit(i, i, i + 1, "x") for i in range(10)]
    assert [[u.id for u in c] for c in chunks(units)] == [[0, 1, 2, 3], [3, 4, 5, 6], [6, 7, 8, 9]]


def test_ai_edit_maps_ids_to_ranges_and_keep_wins(monkeypatch):
    calls = []

    def fake(system, user, model):
        calls.append((system, user, model))
        return {
            "remove": [
                {"lines": [1], "reason": "false_start", "note": "restarted; kept line 2"},
                {"lines": [3, 4, 42], "reason": "off_topic", "note": "chatter"},
                {"lines": [0], "reason": "made_up", "note": ""},
            ],
            "keep": [4],
        }

    monkeypatch.setattr(edit, "call_ollama", fake)
    out = ai_edit(UNITS, instruction="keep the last line")
    assert out["model"] == edit.OLLAMA_MODEL
    assert out["keep_ids"] == [4]
    assert [(r["start"], r["end"], r["ids"], r["reason"]) for r in out["removals"]] == [
        (0.0, 2.0, [0], "repeat"),  # unknown reason falls back
        (2.5, 4.0, [1], "false_start"),
        (7.5, 9.0, [3], "off_topic"),  # 4 kept, 42 doesn't exist
    ]
    system, user, _ = calls[0]
    assert "keep the last complete take" in system
    assert user.endswith("Editor instruction: keep the last line")


def test_ai_edit_best_take_and_claude_needs_key(monkeypatch):
    seen = {}
    monkeypatch.setattr(edit, "call_ollama", lambda s, u, m: seen.setdefault("system", s) and {"remove": [], "keep": []})
    ai_edit(UNITS, prefer_last_take=False)
    assert "keep the best complete take" in seen["system"]
    with pytest.raises(EditError, match="API key"):
        ai_edit(UNITS, provider="claude")


def test_call_ollama_sends_schema_and_parses_reply():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert request.url.path == "/api/chat"
        assert body["model"] == "qwen3:8b" and body["stream"] is False and body["think"] is False
        assert body["format"] == edit.SCHEMA
        assert body["messages"][0]["role"] == "system"
        return httpx.Response(200, json={"message": {"content": '{"remove": [], "keep": [2]}'}})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert call_ollama("sys", "user", "qwen3:8b", client) == {"remove": [], "keep": [2]}


def test_call_ollama_explains_missing_model_and_not_running():
    missing = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404, json={"error": "model not found"})))
    with pytest.raises(EditError, match="ollama pull qwen3:8b"):
        call_ollama("s", "u", "qwen3:8b", missing)

    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(EditError, match="Ollama isn't running"):
        call_ollama("s", "u", "qwen3:8b", httpx.Client(transport=httpx.MockTransport(refuse)))


class FakeClaude:
    def __init__(self, response):
        self.kwargs = None
        self.messages = SimpleNamespace(create=self._create)
        self._response = response

    def _create(self, **kwargs):
        self.kwargs = kwargs
        return self._response


def claude_response(text: str, stop_reason: str = "end_turn"):
    return SimpleNamespace(stop_reason=stop_reason, content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text=text)])


def test_call_claude_request_shape(monkeypatch):
    fake = FakeClaude(claude_response('{"remove": [{"lines": [1], "reason": "retake", "note": "n"}], "keep": []}'))
    monkeypatch.setattr(edit, "make_claude_client", lambda key: fake)
    out = call_claude("sys", "user", "sk-test", "claude-haiku-5-5")
    assert out["remove"][0]["lines"] == [1]
    k = fake.kwargs
    assert k["model"] == "claude-haiku-5-5"
    assert "fallbacks" not in k and "betas" not in k   # never re-run on another model
    assert k["output_config"] == {"effort": "high", "format": {"type": "json_schema", "schema": edit.SCHEMA}}
    assert k["system"] == "sys" and k["messages"] == [{"role": "user", "content": "user"}]
    call_claude("sys", "user", "sk-test", "claude-sonnet-5-5")
    assert fake.kwargs["output_config"]["effort"] == "low"


def test_call_claude_refuses_other_models(monkeypatch):
    monkeypatch.setattr(edit, "make_claude_client", lambda key: FakeClaude(claude_response("{}")))
    for model in ("claude-opus-5-5", "claude-opus-4-8", "claude-fable-5-1"):
        with pytest.raises(EditError, match="only uses Claude Haiku 5.5 or Sonnet 5.5"):
            call_claude("s", "u", "k", model)


def test_call_claude_refusal(monkeypatch):
    monkeypatch.setattr(edit, "make_claude_client", lambda key: FakeClaude(claude_response("", "refusal")))
    with pytest.raises(EditError, match="declined"):
        call_claude("s", "u", "k", "claude-haiku-5-5")


def test_edit_route():
    client = TestClient(app)
    units = [{"id": u.id, "start": u.start, "end": u.end, "text": u.text} for u in UNITS]
    r = client.post("/edit", json={"units": units, "provider": "claude"})
    assert r.status_code == 400 and "API key" in r.json()["detail"]
    assert client.post("/edit", json={"units": [], "provider": "ollama"}).json()["removals"] == []
    assert client.post("/edit", json={"units": units, "provider": "openai"}).status_code == 422


def test_call_claude_through_real_sdk(monkeypatch):
    """The real SDK accepts these parameters and puts them on the wire as expected."""
    import anthropic
    import httpx2

    sent = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent["headers"] = dict(request.headers)
        sent["body"] = json.loads(request.content)
        return httpx2.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
            "content": [{"type": "text", "text": '{"remove": [], "keep": [3]}'}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 5},
        })

    client = anthropic.Anthropic(api_key="sk-test", http_client=httpx2.Client(transport=httpx2.MockTransport(handler)), max_retries=0)
    monkeypatch.setattr(edit, "make_claude_client", lambda key: client)
    assert call_claude("sys", "user", "sk-test", "claude-haiku-5-5") == {"remove": [], "keep": [3]}
    assert sent["headers"]["x-api-key"] == "sk-test"
    assert "anthropic-beta" not in sent["headers"] and "fallbacks" not in sent["body"]
    assert sent["body"]["output_config"] == {"effort": "high", "format": {"type": "json_schema", "schema": edit.SCHEMA}}
    assert sent["body"]["model"] == "claude-haiku-5-5"
