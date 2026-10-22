"""Selects pass: the few clips a senior podcast clip producer would cut, not a pile of markers.

1. Candidates: the model reads the whole episode (numbered sentence lines) against
   a producer's rubric (the editor's brief plus yt-shorts' picking rules) and
   proposes passages. A passage may open with one strong line pulled forward
   from later in the same passage, the way editors cut a hook.
2. Checks in code: 20-60 seconds, lines that exist, no overlaps or repeated ideas.
3. Signals: how lively the passage is compared with the rest of the episode (given
   the episode audio), and the opening line's hook score (yt-script's hookscore),
   which is shown as a tip and only lightly weighted.
4. Pairwise ranking: every candidate that passes goes into Swiss-style rounds
   (about log2 n + 1); the model compares two at a time and wins decide the order.
   More reliable than scoring each alone, and no heuristic shortlist cuts first.
5. Keep five with a mix of types (story, opinion, tip, moment).

The model only ever names line ids; every time and duration is worked out here.
"""

import math
import re
import statistics
from dataclasses import dataclass, field
from typing import Callable

from .edit import EditError, Unit, mmss
from .yt import hookscore, title as title_lint

Ask = Callable[[str, str, dict], dict]

TYPES = ["story", "opinion", "tip", "moment"]
MIN_SECONDS, MAX_SECONDS = 20.0, 60.0
HOOK_REACH = 45.0      # a pulled-forward hook line must come from at most this far after the passage
CHUNK, OVERLAP = 90, 12   # small slices: an 8B model skims when given 25 minutes at once
MAX_ROUNDS = 6

CANDIDATE_SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "first": {"type": "integer"},
                    "last": {"type": "integer"},
                    "hook_line": {"type": "integer"},
                    "type": {"type": "string", "enum": TYPES},
                    "idea": {"type": "string"},
                    "title": {"type": "string"},
                    "why": {"type": "string"},
                },
                "required": ["first", "last", "hook_line", "type", "idea", "title", "why"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["candidates"],
    "additionalProperties": False,
}

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {"winner": {"type": "string", "enum": ["A", "B"]}, "reason": {"type": "string"}},
    "required": ["winner", "reason"],
    "additionalProperties": False,
}

RUBRIC = """A clip is worth cutting only if ALL of these are true:
- It is 20 to 60 seconds long and about ONE idea.
- It makes sense to a stranger who has not seen the episode. The first sentence must not need the previous minute.
- It hooks in the first 3 seconds: the opening line makes the viewer need the rest.
- There is a turn: a claim, then something that complicates or proves it.
- It ends on a line that lands (a payoff), not a trail-off.
- It starts and ends on a complete sentence."""

CANDIDATE_SYSTEM = f"""You are a senior podcast clip producer. You read the whole episode transcript and pick the passages worth cutting as short vertical clips. You are picky: most of an episode is not a clip.

{RUBRIC}

Each line is [id] mm:ss Speaker: text. For each candidate give:
- first, last: the line ids where the passage starts and ends (a contiguous run).
- hook_line: if one line later in the same passage (at most 45 seconds after it ends, or inside it) would make a stronger opening, its id, to be played first, the way editors pull a hook forward. Otherwise -1.
- type: story, opinion, tip or moment (emotional or funny).
- idea: the one idea in at most 8 words.
- title: a working title under 60 characters, specific (a number, a name or a concrete detail beats an adjective).
- why: one sentence on why it works, for the editor.

Give the 3 to 5 best candidates in this part of the episode, or fewer if fewer qualify. Carry each passage through to its payoff line rather than stopping early. Never invent ids."""

JUDGE_SYSTEM = f"""You are a senior podcast clip producer choosing which of two clips to publish first as a short vertical video.

{RUBRIC}

Judge on: would a stranger scrolling past stop in the first 3 seconds, understand it, and watch to the end? Pick A or B, and give the reason in one sentence."""


@dataclass
class Candidate:
    first: int
    last: int
    hook: int | None
    type: str
    idea: str
    title: str
    why: str
    pieces: list[tuple[float, float]] = field(default_factory=list)
    opening: str = ""
    text: str = ""
    hook_score: dict = field(default_factory=dict)
    energy: float | None = None
    wins: int = 0

    @property
    def duration(self) -> float:
        return sum(e - s for s, e in self.pieces)

    @property
    def prelim(self) -> float:
        # Only seeds the first ranking round and breaks ties; the pairwise rounds decide.
        # hookscore is weighted low on purpose: it rated this editor's own published
        # openings 34-43 ("weak"), as its author warns for conversational speech.
        return 0.25 * self.hook_score.get("verdict", 0) + 0.75 * (self.energy if self.energy is not None else 50)


def lines_text(units: list[Unit], speakers: dict[int, str]) -> str:
    return "\n".join(f"[{u.id}] {mmss(u.start)} {speakers.get(u.id, 'Speaker')}: {u.text}" for u in units)


def chunks(units: list[Unit]) -> list[list[Unit]]:
    out, i = [], 0
    while i < len(units):
        out.append(units[i:i + CHUNK])
        if i + CHUNK >= len(units):
            break
        i += CHUNK - OVERLAP
    return out


def build(raw: dict, by_id: dict[int, Unit]) -> Candidate | None:
    """A model proposal → a checked candidate with episode-time pieces, or None if it breaks the rules."""
    return check(raw, by_id)[0]


def check(raw: dict, by_id: dict[int, Unit]) -> tuple[Candidate | None, str]:
    """Like build, but also says why a proposal was dropped (for the eval)."""
    first, last, hook = raw.get("first"), raw.get("last"), raw.get("hook_line", -1)
    if not isinstance(first, int) or not isinstance(last, int) or first not in by_id or last not in by_id or last < first:
        return None, "line ids that don't exist"
    # A passage that stops before its payoff is a fragment: carry it on through the
    # following sentences while the speech flows (no long pause), up to the minimum.
    # (The editor's "going for it" clip ran on into its payoff; the model stopped at 18 s.)
    extended = False
    while (by_id[last].end - by_id[first].start < MIN_SECONDS and last + 1 in by_id
           and by_id[last + 1].start - by_id[last].end < 1.5 and by_id[last + 1].end - by_id[first].start <= MAX_SECONDS):
        last += 1
        extended = True
    run = [by_id[i] for i in range(first, last + 1) if i in by_id]
    hook_unit = by_id.get(hook) if isinstance(hook, int) and hook >= 0 else None
    if hook_unit and not (first <= hook_unit.id <= last or 0 <= hook_unit.start - by_id[last].end <= HOOK_REACH):
        hook_unit = None  # too far away to be the same passage
    if hook_unit and hook_unit.id == first:
        hook_unit = None  # already the opening
    rest = [u for u in run if not hook_unit or u.id != hook_unit.id]
    pieces: list[tuple[float, float]] = [(hook_unit.start, hook_unit.end)] if hook_unit else []
    for u in rest:  # contiguous runs of the remaining lines
        if pieces and len(pieces) > (1 if hook_unit else 0) and abs(u.start - pieces[-1][1]) < 1.5:
            pieces[-1] = (pieces[-1][0], u.end)
        else:
            pieces.append((u.start, u.end))
    c = Candidate(first, last, hook_unit.id if hook_unit else None,
                  raw.get("type") if raw.get("type") in TYPES else "moment",
                  str(raw.get("idea", ""))[:80], str(raw.get("title", ""))[:100], str(raw.get("why", ""))[:240],
                  pieces=[(round(s, 2), round(e, 2)) for s, e in pieces])
    if not MIN_SECONDS <= c.duration <= MAX_SECONDS:
        return None, f"{'too short' if c.duration < MIN_SECONDS else 'too long'} ({c.duration:.0f}s)"
    c.opening = (hook_unit or run[0]).text
    c.text = " ".join(u.text for u in ([hook_unit] if hook_unit else []) + rest)
    return c, "passed checks (extended to finish the thought)" if extended else ""


def overlap(a: Candidate, b: Candidate) -> float:
    return sum(max(0.0, min(e1, e2) - max(s1, s2)) for s1, e1 in a.pieces for s2, e2 in b.pieces)


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


def dedupe(cands: list[Candidate]) -> list[Candidate]:
    """Best first; drop any that overlap a kept one by 30% of the shorter, or repeat its idea."""
    kept: list[Candidate] = []
    for c in sorted(cands, key=lambda c: -c.prelim):
        if any(overlap(c, k) > 0.3 * min(c.duration, k.duration) or (norm(c.idea) and norm(c.idea) == norm(k.idea)) for k in kept):
            continue
        kept.append(c)
    return kept


def energy_scores(cands: list[Candidate], db: list[float], rate: int) -> None:
    """How lively each passage is against the episode's typical speech level, 0-100 (50 = typical)."""
    speech = [v for v in db if v > -60]
    if not speech:
        return
    typical = statistics.median(speech)
    for c in cands:
        frames = [db[i] for s, e in c.pieces for i in range(int(s * rate), min(len(db), int(e * rate))) if db[i] > -60]
        if frames:
            lively = statistics.mean(frames) - typical + 0.5 * (statistics.pstdev(frames) if len(frames) > 1 else 0)
            c.energy = round(max(0.0, min(100.0, 50 + 6 * lively)), 1)


def rounds_for(n: int) -> int:
    """Enough Swiss rounds to sort n candidates (about log2 n, plus one), capped."""
    return max(1, min(MAX_ROUNDS, math.ceil(math.log2(max(n, 2))) + 1))


def swiss(cands: list[Candidate], ask: Ask, rounds: int | None = None, progress: Callable[[str], None] = lambda s: None) -> None:
    """Pairwise comparisons over a few rounds; each candidate meets a similar-ranked one each round."""
    def clip_block(c: Candidate) -> str:
        return f"{round(c.duration)}s, {c.type}. Opening line: \"{c.opening}\"\nFull text: {c.text}"
    rounds = rounds or rounds_for(len(cands))
    played: set[tuple[int, int]] = set()
    sat_out: set[int] = set()
    total = rounds * (len(cands) // 2)
    done = 0
    for r in range(rounds):
        pool = sorted(cands, key=lambda c: (-c.wins, -c.prelim))
        if len(pool) % 2:  # odd count: the lowest-ranked who hasn't sat out yet sits this round out
            bye = next((c for c in reversed(pool) if id(c) not in sat_out), pool[-1])
            sat_out.add(id(bye))
            pool.remove(bye)
        while len(pool) >= 2:
            a = pool.pop(0)
            b = next((c for c in pool if (id(a), id(c)) not in played), pool[0])  # avoid rematches
            pool.remove(b)
            played |= {(id(a), id(b)), (id(b), id(a))}
            done += 1
            progress(f"Comparing clips head to head: {done} of {total}")
            verdict = ask(JUDGE_SYSTEM, f"Clip A: {clip_block(a)}\n\nClip B: {clip_block(b)}", JUDGE_SCHEMA)
            (a if verdict.get("winner") == "A" else b).wins += 1


def pick_varied(ranked: list[Candidate], n: int) -> list[Candidate]:
    """Top n, but make room for each type that has a contender in the shortlist."""
    picked: list[Candidate] = []
    for t in TYPES:
        best = next((c for c in ranked if c.type == t), None)
        if best and len(picked) < n:
            picked.append(best)
    for c in ranked:
        if len(picked) >= n:
            break
        if c not in picked:
            picked.append(c)
    return sorted(picked, key=ranked.index)


def run_selects(units: list[Unit], ask: Ask, speakers: dict[int, str] | None = None,
                audio_db: list[float] | None = None, audio_rate: int = 10, count: int = 5,
                progress: Callable[[str], None] = lambda s: None) -> dict:
    if len(units) < 10:
        raise EditError("Not enough transcript to find clips in.")
    speakers = speakers or {}
    by_id = {u.id: u for u in units}
    raw: list[dict] = []
    parts = chunks(units)
    for n, part in enumerate(parts, 1):
        progress(f"Reading the episode for clips: part {n} of {len(parts)} ({mmss(part[0].start)}–{mmss(part[-1].end)})")
        raw += ask(CANDIDATE_SYSTEM, f"Transcript:\n{lines_text(part, speakers)}", CANDIDATE_SCHEMA).get("candidates", [])
    proposed = len(raw)
    # Every proposal and what happened to it, so an eval can tell "never proposed" from "dropped".
    record: list[dict] = []
    cands: list[Candidate] = []
    for r in raw:
        c, reason = check(r, by_id)
        first, last = r.get("first"), r.get("last")
        span = [by_id[first].start, by_id[last].end] if first in by_id and last in by_id else None
        record.append({"title": str(r.get("title", ""))[:100], "span": span, "status": reason if not c else (reason or "passed checks"), "candidate": c})
        if c:
            cands.append(c)
    for c in cands:
        parts, verdict, formula, _ = hookscore.score(c.opening)
        weakest = min(parts, key=parts.get)
        c.hook_score = {"verdict": verdict, "band": hookscore.band(verdict), "weakest": weakest, "fix": hookscore.FIX[weakest], "formula": formula}
    if audio_db:
        energy_scores(cands, audio_db, audio_rate)
    # Every candidate that passes the checks goes into the head-to-head rounds. A shortlist
    # cut by liveliness and hook score threw out both of this editor's published moments.
    deduped = dedupe(cands)
    shortlist = deduped
    for entry in record:
        c = entry.pop("candidate")
        if c and c not in deduped:
            entry["status"] = "dropped: overlaps a better pick or repeats its idea"
        elif c and c not in shortlist:
            entry["status"] = "passed, but not compared"
    progress(f"{len(cands)} of {proposed} proposals passed the checks; shortlisted {len(shortlist)}")
    if len(shortlist) > 1:
        swiss(shortlist, ask, progress=progress)
    ranked = sorted(shortlist, key=lambda c: (-c.wins, -c.prelim))
    clips = []
    for rank, c in enumerate(pick_varied(ranked, count), 1):
        lint = title_lint.check(c.title) if c.title else {"score": 0, "issues": [("missing", "no title")]}
        clips.append({
            "rank": rank, "title": c.title, "title_check": {"score": lint["score"], "issues": [m for _, m in lint["issues"]]},
            "type": c.type, "idea": c.idea, "opening_line": c.opening, "why": c.why,
            "pieces": [{"start": s, "end": e} for s, e in c.pieces], "duration": round(c.duration, 1),
            "hook_pulled_forward": c.hook is not None, "hook_score": c.hook_score, "energy": c.energy, "wins": c.wins,
            "lines": [c.first, c.last],
        })
    picked = {(c["lines"][0], c["lines"][1]) for c in clips}
    for entry, r in zip(record, raw):
        if (r.get("first"), r.get("last")) in picked:
            entry["status"] = "picked"
        elif entry["status"].startswith("passed checks"):
            entry["status"] = "shortlisted, lost the head-to-head comparisons" + (" (extended)" if "extended" in entry["status"] else "")
    return {"clips": clips, "proposed": proposed, "valid": len(cands), "shortlisted": len(shortlist), "proposals": record}


CHAPTER_SCHEMA = {
    "type": "object",
    "properties": {"titles": {"type": "array", "items": {"type": "string"}}},
    "required": ["titles"],
    "additionalProperties": False,
}

CHAPTER_SYSTEM = """You title YouTube chapters for a podcast episode. For each numbered section, write the promise of that section in 3 to 5 plain words, sentence case, the way the viewer would say it. No clickbait, no colons, no quotes. Return exactly one title per section, in order."""


def run_chapters(units: list[Unit], ask: Ask) -> dict:
    """6-10 chapters: boundaries from yt-chapters' pause + vocabulary-shift method, titles by the model."""
    from .yt import chapters as yt_chapters
    duration = units[-1].end if units else 0
    target = max(6, min(10, round(duration / 360)))
    found = yt_chapters.boundaries([(u.start, u.end, u.text) for u in units], target)
    if not found["chapters"]:
        raise EditError("Not enough transcript to make chapters.")
    sections = "\n\n".join(f"{i + 1}. ({c['label']}) {c['text'][:500]}" for i, c in enumerate(found["chapters"]))
    titles = ask(CHAPTER_SYSTEM, f"Sections:\n{sections}", CHAPTER_SCHEMA).get("titles", [])
    chapters = [{"start": c["start"], "label": c["label"], "seconds": c["seconds"],
                 "title": (titles[i].strip() if i < len(titles) and isinstance(titles[i], str) and titles[i].strip() else c["draft_title"])}
                for i, c in enumerate(found["chapters"])]
    return {"valid": found["valid"], "chapters": chapters, "text": "\n".join(f"{c['label']} {c['title']}" for c in chapters)}
