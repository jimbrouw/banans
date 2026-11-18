"""YouTube chapters from sentence units.

Adapted from yt-chapters/chapters.py in Jake Schincariol's YouTube agent skill
pack (MIT, see LICENSE). Same method: boundaries are the pauses actually taken,
scored by pause length and how much the vocabulary changes across them; then
YouTube's own rules are enforced (first entry at 0:00, at least three, each at
least 10 seconds), because a list breaking any of them silently doesn't render.
Changed: takes [(start, end, text)] sentence units instead of parsing a subtitle
file, and returns data instead of printing.
"""
import re

STOP = set("the a an of for to in on and or is are was were be been with this that it as at by from "
           "you your i my we our they them he she but so if then than there here what which who how "
           "when where why not no yes do does did just really very like about into over out up down "
           "can could will would should have has had get got make made go going went one two".split())
MIN_SECONDS = 10.0


def keywords(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z']{4,}", text.lower()) if w not in STOP}


def label(t: float) -> str:
    t = int(t)
    h, m, s = t // 3600, (t % 3600) // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def boundaries(units: list[tuple[float, float, str]], target: int = 8) -> dict:
    """Chapter starts (seconds) with draft titles, plus whether YouTube would render them."""
    if len(units) < 6:
        return {"valid": False, "chapters": [], "reason": "too little speech to chapter"}
    duration = units[-1][1]
    candidates = []
    for i in range(1, len(units)):
        gap = units[i][0] - units[i - 1][1]
        before = " ".join(u[2] for u in units[max(0, i - 12):i])
        after = " ".join(u[2] for u in units[i:i + 12])
        kb, ka = keywords(before), keywords(after)
        shift = 1 - (len(kb & ka) / len(kb | ka)) if (kb | ka) else 0
        candidates.append((gap * 1.6 + shift * 3.2, units[i][0]))
    candidates.sort(reverse=True)
    picked = [0.0]
    for _, t in candidates:
        if len(picked) >= target:
            break
        if all(abs(t - p) >= MIN_SECONDS for p in picked) and duration - t >= MIN_SECONDS:
            picked.append(t)
    picked.sort()
    chapters = []
    for n, t in enumerate(picked):
        end = picked[n + 1] if n + 1 < len(picked) else duration
        text = " ".join(u[2] for u in units if u[0] >= t and u[1] <= end)
        kw = sorted(keywords(text), key=lambda w: -text.lower().count(w))
        chapters.append({"start": round(t, 2), "label": label(t), "draft_title": " ".join(w.capitalize() for w in kw[:3]) or "Section",
                         "seconds": round(end - t, 2), "text": text})
    valid = len(chapters) >= 3 and chapters[0]["start"] == 0 and all(c["seconds"] >= MIN_SECONDS for c in chapters)
    return {"valid": valid, "chapters": chapters}
