"""Headless multicam auto cut: who's talking on which mic → which camera is on screen.

A port of the panel's TypeScript, so a cut made here matches one made in Premiere:
- detect_speakers / turns_to_segments  ← src/podcastSpeakers.ts
- generate_cut_map / evaluate_cut_map  ← src/autopilot.ts (profiles, min shot,
  acknowledgement filter, wide on crosstalk, rotation fallback, the four checks)
New here, not in the TS yet: reaction cuts, a short cutaway to the listener
during a long monologue, placed on the speaker's quietest breath.

tests/test_auto_cut.py runs the same fixtures as src/autopilot.test.ts so the
two ports can't drift apart silently.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

FLOOR_DB = -100.0
RATE = 10  # envelope frames per second (the /levels default)


@dataclass(frozen=True)
class SpeakerOptions:
    speech_above_floor_db: float = 12
    bleed_db: float = 6
    min_turn: float = 0.4
    max_gap: float = 0.6


@dataclass(frozen=True)
class Profile:
    name: str
    min_shot: float
    aggressiveness: str          # low | medium | high
    reaction_after: float        # seconds on one speaker before a reaction cutaway
    reaction_len: float


PROFILES = [
    Profile("Balanced (Recommended)", 2.5, "medium", 14.0, 2.5),
    Profile("Dynamic Cut", 1.5, "high", 9.0, 1.8),
    Profile("Conservative Dialogue", 4.0, "low", 24.0, 4.0),
]
MAX_CUTS_PER_MIN = {"high": 12, "medium": 8, "low": 5}


@dataclass
class Segment:
    speaker: int      # mic index
    start: float
    end: float


@dataclass
class Cut:
    frame: int
    camera: int       # camera index
    reason: str = "speaker"


@dataclass
class Check:
    label: str
    passed: bool
    detail: str


@dataclass
class CameraPlan:
    """Who is on which camera. camera_for_mic[m] is the close-up for mic m; wide may be None."""
    camera_for_mic: list[int]
    wide: int | None
    coverage: list[tuple[float, float]]   # per camera: [start, end) seconds it was rolling

    def rolling(self, cam: int, t: float) -> bool:
        s, e = self.coverage[cam]
        return s <= t < e


@dataclass
class AutoCutResult:
    profile: Profile
    cuts: list[Cut]
    score: int
    checks: list[Check]
    segments: list[Segment]
    talk_share: list[float] = field(default_factory=list)


# ── speakers from mic levels (podcastSpeakers.ts) ────────────────────────────

def place_envelope(db: list[float], start: float, duration: float, rate: int = RATE) -> np.ndarray:
    """One mic's dB envelope moved onto the session timeline."""
    out = np.full(int(np.ceil(duration * rate)), FLOOR_DB)
    offset = int(round(start * rate))
    src = np.asarray(db, dtype=float)[: max(0, len(out) - offset)]
    out[offset: offset + len(src)] = src
    return out


def _noise_floor(db: np.ndarray) -> float:
    live = np.sort(db[db > FLOOR_DB + 1])
    return float(live[int(len(live) * 0.05)]) if len(live) else FLOOR_DB


def _smooth(active: np.ndarray, rate: int, o: SpeakerOptions) -> list[tuple[int, int]]:
    runs: list[list[int]] = []
    for i in np.flatnonzero(active):
        if runs and i - runs[-1][1] <= o.max_gap * rate:
            runs[-1][1] = i + 1
        else:
            runs.append([i, i + 1])
    return [(a, b) for a, b in runs if b - a >= o.min_turn * rate]


def detect_speakers(envelopes: list[np.ndarray], rate: int = RATE, o: SpeakerOptions = SpeakerOptions()) -> list[list[tuple[float, float]]]:
    """Per mic, the (start, end) seconds it is the active speaker: well above its own floor
    AND within bleed_db of the loudest mic, which rejects bleed but keeps real crosstalk."""
    n = max(len(e) for e in envelopes)
    rel = np.stack([np.pad(e, (0, n - len(e)), constant_values=FLOOR_DB) - _noise_floor(e) for e in envelopes])
    loudest = rel.max(axis=0)
    active = (rel >= o.speech_above_floor_db) & (rel >= loudest - o.bleed_db)
    return [[(a / rate, b / rate) for a, b in _smooth(row, rate, o)] for row in active]


def turns_to_segments(turns: list[list[tuple[float, float]]]) -> list[Segment]:
    return sorted((Segment(m, s, e) for m, runs in enumerate(turns) for s, e in runs), key=lambda g: g.start)


def talk_share(turns: list[list[tuple[float, float]]]) -> list[float]:
    totals = [sum(e - s for s, e in runs) for runs in turns]
    return [t / (sum(totals) or 1) for t in totals]


# ── cut map (autopilot.ts) ───────────────────────────────────────────────────

def generate_cut_map(segments: list[Segment], plan: CameraPlan, profile: Profile, total_frames: int, fps: float) -> list[Cut]:
    to_frame = lambda sec: min(total_frames - 1, max(0, round(sec * fps)))  # noqa: E731
    ordered = sorted(segments, key=lambda g: g.start)
    if not ordered:
        return [Cut(0, plan.camera_for_mic[0])]
    cuts: list[Cut] = []
    last_cam, last_switch = -1, -100.0
    for i, seg in enumerate(ordered):
        nxt = ordered[i + 1] if i + 1 < len(ordered) else None
        short = (seg.end - seg.start) < profile.min_shot  # mic turns carry no text, so no acknowledgement regex
        overlaps = nxt is not None and nxt.speaker != seg.speaker and nxt.start < seg.end - 0.25
        target, reason = plan.camera_for_mic[seg.speaker], "speaker"
        if overlaps and plan.wide is not None:
            target, reason = plan.wide, "crosstalk"
        if not plan.rolling(target, seg.start):
            continue  # that camera wasn't recording yet (or had stopped)
        if short and profile.aggressiveness != "high":
            continue
        if target == last_cam:
            continue
        if last_cam != -1 and seg.start - last_switch < profile.min_shot:
            continue
        cuts.append(Cut(to_frame(seg.start), target, reason))
        last_cam, last_switch = target, seg.start

    if not cuts:
        cuts.append(Cut(0, plan.camera_for_mic[0]))
    elif cuts[0].frame > 0:
        cuts.insert(0, Cut(0, cuts[0].camera, cuts[0].reason))
    clean: dict[int, Cut] = {}
    for c in cuts:  # same frame twice: keep the last
        clean[c.frame] = c
    out = sorted(clean.values(), key=lambda c: c.frame)
    if len({c.camera for c in out}) <= 1 and len(plan.coverage) >= 2:
        return _rotate(ordered, len(plan.coverage), profile, total_frames, fps)
    return out


def _rotate(ordered: list[Segment], n_cams: int, profile: Profile, total_frames: int, fps: float) -> list[Cut]:
    """Cadence rotation when nobody could be told apart."""
    min_interval = max(profile.min_shot, 60 / MAX_CUTS_PER_MIN[profile.aggressiveness])
    cuts, last, idx = [Cut(0, 0, "rotation")], 0.0, 0
    for seg in ordered:
        if seg.start - last < min_interval:
            continue
        idx = (idx + 1) % n_cams
        frame = min(total_frames - 1, max(0, round(seg.start * fps)))
        if frame > cuts[-1].frame:
            cuts.append(Cut(frame, idx, "rotation"))
            last = seg.start
    return cuts


def add_reactions(cuts: list[Cut], segments: list[Segment], envelopes: list[np.ndarray], plan: CameraPlan,
                  profile: Profile, total_frames: int, fps: float) -> list[Cut]:
    """Break a long hold on one speaker with a cutaway to the listener, on the speaker's quietest breath."""
    out: list[Cut] = []
    for i, cut in enumerate(cuts):
        out.append(cut)
        if cut.reason != "speaker":
            continue
        start = cut.frame / fps
        end = (cuts[i + 1].frame if i + 1 < len(cuts) else total_frames) / fps
        speaker = plan.camera_for_mic.index(cut.camera) if cut.camera in plan.camera_for_mic else None
        if speaker is None:
            continue
        t = start
        while end - t > profile.reaction_after + profile.reaction_len + profile.min_shot:
            lo, hi = t + profile.reaction_after * 0.6, min(t + profile.reaction_after * 1.4, end - profile.reaction_len - profile.min_shot)
            if hi <= lo:
                break
            a, b = int(lo * RATE), int(hi * RATE)
            env = envelopes[speaker][a:b]
            if len(env) < 3:
                break
            breath = (a + int(np.argmin(np.convolve(env, np.ones(3) / 3, mode="same")))) / RATE
            listener = _listener(segments, speaker, breath, plan)
            if listener is None or not plan.rolling(listener, breath):
                break
            out.append(Cut(round(breath * fps), listener, "reaction"))
            back = breath + profile.reaction_len
            out.append(Cut(round(back * fps), cut.camera, "speaker"))
            t = back
    return out


def _listener(segments: list[Segment], speaker: int, at: float, plan: CameraPlan) -> int | None:
    """The camera of whoever spoke last before `at` other than the speaker; else the wide."""
    for seg in sorted((s for s in segments if s.speaker != speaker and s.start < at), key=lambda s: -s.start):
        return plan.camera_for_mic[seg.speaker]
    return plan.wide


def evaluate_cut_map(cuts: list[Cut], segments: list[Segment], plan: CameraPlan, profile: Profile,
                     total_frames: int, fps: float) -> tuple[int, list[Check]]:
    duration = total_frames / fps
    per_min = (len(cuts) - 1) / (duration / 60 or 1) if cuts else 0
    bounds = [c.frame / fps for c in cuts] + [duration]
    lengths = [b - a for a, b in zip(bounds, bounds[1:])]
    shortest = min(lengths) if lengths else 0
    limit = MAX_CUTS_PER_MIN[profile.aggressiveness]

    overlap_total = overlap_ok = 0
    ordered = sorted(segments, key=lambda g: g.start)
    for seg, nxt in zip(ordered, ordered[1:]):
        if nxt.speaker != seg.speaker and nxt.start < seg.end - 0.25:
            overlap_total += 1
            mid = (seg.end + nxt.start) / 2
            active = next((c for c in reversed(cuts) if c.frame / fps <= mid), None)
            overlap_ok += bool(active and active.camera == plan.wide)

    checks = [
        Check("Shot Duration Check", shortest >= profile.min_shot,
              f"All shots meet the minimum duration of {profile.min_shot}s." if shortest >= profile.min_shot
              else f"Some shots are shorter than {profile.min_shot}s (shortest: {shortest:.1f}s)."),
        Check("Switch Frequency Check", per_min <= limit, f"Pace is {per_min:.1f} cuts/min (limit for profile is {limit}/min)."),
        Check("Overlap Wide Check", overlap_total == 0 or overlap_ok / overlap_total >= 0.75,
              "No conversational overlaps detected." if overlap_total == 0 else f"{overlap_ok}/{overlap_total} overlaps correctly cut to Wide camera."),
        Check("Switch Stability Check", all(b - a >= 1.0 for a, b in zip(bounds[:-1], bounds[1:-1])),
              "No rapid camera switches within 1.0s."),
    ]
    return round(100 * sum(c.passed for c in checks) / len(checks)), checks


def auto_cut(envelopes: list[np.ndarray], plan: CameraPlan, total_frames: int, fps: float,
             reactions: bool = True) -> list[AutoCutResult]:
    """Every profile's cut, best score first (ties keep profile order, so Balanced wins)."""
    turns = detect_speakers(envelopes)
    segments = turns_to_segments(turns)
    share = talk_share(turns)
    results = []
    for profile in PROFILES:
        cuts = generate_cut_map(segments, plan, profile, total_frames, fps)
        if reactions:
            cuts = add_reactions(cuts, segments, envelopes, plan, profile, total_frames, fps)
        score, checks = evaluate_cut_map(cuts, segments, plan, profile, total_frames, fps)
        results.append(AutoCutResult(profile, cuts, score, checks, segments, share))
    return sorted(results, key=lambda r: -r.score)


def cuts_to_intervals(cuts: list[Cut], total_frames: int) -> list[tuple[int, int, int, str]]:
    """(start, end, camera, reason) frame intervals covering the whole sequence."""
    ends = [c.frame for c in cuts[1:]] + [total_frames]
    return [(c.frame, e, c.camera, c.reason) for c, e in zip(cuts, ends) if e > c.frame]
