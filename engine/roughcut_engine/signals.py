"""Hints for the candidate pass: which lines in a chunk look worth a clip, from cheap signals.

The model reads a chunk blind to how the episode sounded. These are the lines a producer's ear
would catch first (a question, a beat of silence before a line, a quick exchange between speakers,
a louder moment). They go into the prompt as hints only. They never cut or rank candidates:
a heuristic shortlist once threw out both of the editor's published moments.
"""

import re
import statistics

from .edit import Unit, mmss

TOP = 12
MIN_SCORE = 1.5          # one weak signal alone isn't worth the model's attention
PAUSE_BEFORE = 1.0       # seconds of silence before a line
QUICK_TURN = 6.0         # a line this short after another speaker's is an exchange
PUNCHY_WORDS = 8
LOUD_OVER_TYPICAL = 6.0  # dB above the episode's median speech level
LOUD_FRAMES = 2          # a cough or a clap is one frame; a raised voice is more
SPEECH_FLOOR = -60.0     # quieter than this isn't speech

TRIGGER = re.compile(r"\b(wait|no way|seriously|actually|however|mistake|secret|wild|crazy|insane|never|always|nobody|everybody|why|how|haha|lol)\b", re.I)


def loud_lines(units: list[Unit], db: list[float], rate: int) -> set[int]:
    """Ids of lines with a stretch clearly louder than the episode's usual speech level."""
    speech = [v for v in db if v > SPEECH_FLOOR]
    if not speech:
        return set()
    threshold = statistics.median(speech) + LOUD_OVER_TYPICAL
    loud = set()
    for u in units:
        frames = db[int(u.start * rate):int(u.end * rate)]
        if sum(v >= threshold for v in frames) >= LOUD_FRAMES:
            loud.add(u.id)
    return loud


def hot_lines(units: list[Unit], speakers: dict[int, str], audio_db: list[float] | None = None,
              rate: int = 10, top: int = TOP) -> list[tuple[float, Unit, list[str]]]:
    """The best-scoring lines of a chunk, best first, each with the reasons it scored."""
    loud = loud_lines(units, audio_db, rate) if audio_db else set()
    scored: list[tuple[float, Unit, list[str]]] = []
    for i, u in enumerate(units):
        score, why = 0.0, []
        prev = units[i - 1] if i else None
        if "?" in u.text:
            score += 1.5
            why.append("question")
        if TRIGGER.search(u.text):
            score += 2.0
            why.append("trigger word")
        if "!" in u.text:
            score += 1.0
            why.append("emphatic")
        if prev and u.start - prev.end >= PAUSE_BEFORE:
            score += 1.0
            why.append("pause before")
        if (prev and speakers.get(prev.id) and speakers.get(u.id) and speakers[prev.id] != speakers[u.id]
                and u.end - u.start <= QUICK_TURN):
            score += 1.25
            why.append("quick exchange")
        if len(u.text.split()) <= PUNCHY_WORDS:
            score += 0.5
            why.append("short and punchy")
        if u.id in loud:
            score += 1.25
            why.append("louder")
        if score >= MIN_SCORE:
            scored.append((score, u, why))
    scored.sort(key=lambda s: -s[0])  # stable: equal scores stay in episode order
    return scored[:top]


def hint_block(units: list[Unit], speakers: dict[int, str], audio_db: list[float] | None = None, rate: int = 10) -> str:
    """The hints as a prompt section, or "" when nothing in the chunk stands out."""
    lines = hot_lines(units, speakers, audio_db, rate)
    if not lines:
        return ""
    body = "\n".join(f"- [{u.id}] {mmss(u.start)} ({', '.join(why)}): {u.text[:120]}" for _, u, why in sorted(lines, key=lambda s: s[1].id))
    return ("\n\nHints from the audio and pacing: lines that may be worth a closer look. "
            "They are hints only. Pick by the rubric, and every clip must still be a contiguous run of lines.\n" + body)
