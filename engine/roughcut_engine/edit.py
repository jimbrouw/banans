"""AI editing pass: find retakes, false starts, repeats and off-topic chatter.

The panel sends the transcript as numbered lines (sentence-sized units with
sequence times). The model returns line ids to remove and keep; we map those
back to time ranges. Working in line ids, not timestamps, keeps the model's
job to judgement and leaves all timing to code.

The model is Claude, with the editor's own API key.
"""

import json
from dataclasses import dataclass

# Cost: only these two, each at the effort that keeps it cheap. Never Opus.
CLAUDE_EFFORT = {"claude-haiku-5-5": "high", "claude-sonnet-5-5": "low"}
CLAUDE_MODEL = "claude-sonnet-5-5"

CHUNK_LINES = 250
CHUNK_OVERLAP = 15

REASONS = ["retake", "false_start", "repeat", "off_topic", "instruction"]

SCHEMA = {
    "type": "object",
    "properties": {
        "remove": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "lines": {"type": "array", "items": {"type": "integer"}},
                    "reason": {"type": "string", "enum": REASONS},
                    "note": {"type": "string"},
                },
                "required": ["lines", "reason", "note"],
                "additionalProperties": False,
            },
        },
        "keep": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["remove", "keep"],
    "additionalProperties": False,
}

SYSTEM = """You are an assistant editor doing the first pass on the raw transcript of a talking-head video or podcast. Each line is one sentence or phrase, written as [id] mm:ss text.

Find lines the final edit should not contain:
- retake: the speaker says the same sentence or idea again because the first attempt went wrong. {take_rule}
- false_start: an abandoned fragment the speaker restarts straight away ("So the, so what I mean is").
- repeat: a point made again later that adds nothing new.
- off_topic: recording chatter not meant for the audience ("is it recording?", "let me do that again", "cut that bit").

Be conservative. A wrong cut loses content the editor wanted; a missed cut costs them a few seconds. Only remove a line when you are confident, and keep anything that carries meaning. Ignore filler words like um and uh; they are handled separately, so never remove a line just for containing them.

Group the lines of one retake or false start into a single entry, and write a short note an editor can scan, such as "first attempt; kept line 41".

If the editor gives an instruction, follow it: lines it asks to cut go in remove with reason "instruction", and lines it asks to keep go in keep.

Use only line ids that appear in the transcript."""

LAST_TAKE = "Remove the earlier attempts and keep the last complete take, which is usually the one the speaker meant to use."
BEST_TAKE = "Remove the weaker attempts and keep the best complete take."


class EditError(Exception):
    pass


@dataclass
class Unit:
    id: int
    start: float
    end: float
    text: str


def mmss(t: float) -> str:
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def build_prompt(units: list[Unit], instruction: str | None) -> str:
    lines = "\n".join(f"[{u.id}] {mmss(u.start)} {u.text}" for u in units)
    out = f"Transcript:\n{lines}"
    if instruction and instruction.strip():
        out += f"\n\nEditor instruction: {instruction.strip()}"
    return out


def parse_reply(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):  # some local models fence JSON anyway
        text = text.strip("`").removeprefix("json").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise EditError(f"The model didn't return valid JSON: {text[:200]}") from e
    if not isinstance(data, dict):
        raise EditError("The model returned JSON that isn't an object.")
    return data


# ── providers ─────────────────────────────────────────────────────────────────

def make_claude_client(api_key: str):
    import anthropic
    return anthropic.Anthropic(api_key=api_key)


def call_claude(system: str, user: str, api_key: str, model: str, schema: dict = SCHEMA) -> dict:
    import anthropic
    if model not in CLAUDE_EFFORT:
        raise EditError(f"RoughCut only uses Claude Haiku 5.5 or Sonnet 5.5, not {model}.")
    client = make_claude_client(api_key)
    try:
        # No server-side fallback: it can re-run a declined request on another (pricier) model.
        response = client.messages.create(
            model=model,
            # Thinking counts towards this (you only pay for what is used). Above ~21k the SDK insists on streaming.
            max_tokens=20000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": CLAUDE_EFFORT[model], "format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.AuthenticationError as e:
        raise EditError("Claude rejected the API key.") from e
    except anthropic.RateLimitError as e:
        raise EditError("Claude rate limit reached. Try again in a minute.") from e
    except anthropic.APIStatusError as e:
        raise EditError(f"Claude API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise EditError("Couldn't reach the Claude API.") from e
    if response.stop_reason == "refusal":
        raise EditError("Claude declined to edit this transcript.")
    if response.stop_reason == "max_tokens":
        raise EditError("Claude's answer was cut off. Try a shorter section.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    return parse_reply(text)


# ── orchestration ─────────────────────────────────────────────────────────────

def chunks(units: list[Unit]) -> list[list[Unit]]:
    if len(units) <= CHUNK_LINES:
        return [units]
    out, i = [], 0
    while i < len(units):
        out.append(units[i:i + CHUNK_LINES])
        if i + CHUNK_LINES >= len(units):
            break
        i += CHUNK_LINES - CHUNK_OVERLAP
    return out


def to_ranges(ids: list[int], by_id: dict[int, Unit]) -> list[tuple[float, float, list[int]]]:
    """Contiguous runs of line ids → (start, end, ids) time ranges."""
    ordered = sorted(set(i for i in ids if i in by_id))
    runs: list[list[int]] = []
    for i in ordered:
        if runs and i == runs[-1][-1] + 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    return [(by_id[r[0]].start, by_id[r[-1]].end, r) for r in runs]


NO_KEY = "Add your Claude API key in the Setup tab first."


def asker(model: str | None, api_key: str | None):
    """A function (system, user, schema) -> dict for passes beyond /edit."""
    if not api_key:
        raise EditError(NO_KEY)
    model = model or CLAUDE_MODEL
    return model, lambda system, user, schema: call_claude(system, user, api_key, model, schema)


def ai_edit(
    units: list[Unit],
    model: str | None = None,
    api_key: str | None = None,
    instruction: str | None = None,
    prefer_last_take: bool = True,
) -> dict:
    if not units:
        return {"model": model, "removals": [], "keep_ids": []}
    if not api_key:
        raise EditError(NO_KEY)
    model = model or CLAUDE_MODEL
    system = SYSTEM.replace("{take_rule}", LAST_TAKE if prefer_last_take else BEST_TAKE)
    by_id = {u.id: u for u in units}

    entries: list[tuple[list[int], str, str]] = []
    seen: set[int] = set()  # overlapping chunks may flag the same line twice
    keep: set[int] = set()
    for part in chunks(units):
        user = build_prompt(part, instruction)
        reply = call_claude(system, user, api_key, model)
        allowed = {u.id for u in part}
        keep.update(i for i in reply.get("keep", []) if isinstance(i, int) and i in allowed)
        for entry in reply.get("remove", []):
            ids = [i for i in entry.get("lines", []) if isinstance(i, int) and i in allowed and i not in seen]
            seen.update(ids)
            reason = entry.get("reason") if entry.get("reason") in REASONS else "repeat"
            entries.append((ids, reason, str(entry.get("note", ""))[:200]))

    # An explicit keep wins over any removal of the same line.
    removals = [
        {"start": start, "end": end, "ids": run, "reason": reason, "note": note}
        for ids, reason, note in entries
        for start, end, run in to_ranges([i for i in ids if i not in keep], by_id)
    ]
    removals.sort(key=lambda r: r["start"])
    return {"model": model, "removals": removals, "keep_ids": sorted(keep)}
