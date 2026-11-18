"""Line up the cameras and mics of one recording session on a single timeline.

Two passes, cheapest first:

1. Timecode. SMPTE timecode on a video stream (or a tmcd track) and a BWF
   time reference on a WAV put every file on one clock without decoding audio.
   Rejected when any member lacks it, or when it looks unjammed: all zero, or
   files that would not even overlap.
2. Waveform. A window of each camera's scratch audio is found inside the sum
   of the mic stems by FFT cross-correlation: coarse at 4 kHz over the search
   range, then refined at 16 kHz to well under a millisecond. A second window
   near the end measures clock drift.

Reads go through ffmpeg with -ss before -i, so on a LucidLink mount only the
blocks under each analysis window are fetched, never the whole proxy.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfiltfilt

from .media import MediaError

COARSE_RATE = 4000
FINE_RATE = 16000
WINDOW_S = 60.0          # camera audio searched for, coarse pass
FINE_WINDOW_S = 20.0     # camera audio searched for, fine pass
PRIOR_MARGIN_S = 15.0    # search ± this around a timestamp-derived guess
MIN_PSR = 6.0            # peak-to-sidelobe ratio below this is not a match
SAME_RECORDER_S = 0.05   # stems whose lengths agree this closely share a clock


# ── probing ───────────────────────────────────────────────────────────────────

@dataclass
class Probe:
    path: Path
    duration: float
    fps: Fraction | None = None          # video only
    width: int = 0
    height: int = 0
    audio_rate: int = 0
    audio_channels: int = 0
    timecode: str | None = None
    time_reference: int | None = None    # BWF: samples since midnight
    creation_time: str | None = None

    @property
    def has_video(self) -> bool:
        return self.fps is not None


def probe(path: Path) -> Probe:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise MediaError(f"ffprobe could not read {path.name}: {proc.stderr.strip()[-300:]}")
    info = json.loads(proc.stdout)
    fmt = info.get("format", {})
    fmt_tags = {k.lower(): v for k, v in fmt.get("tags", {}).items()}
    p = Probe(path=path, duration=float(fmt.get("duration", 0)), creation_time=fmt_tags.get("creation_time"))
    if "time_reference" in fmt_tags:
        p.time_reference = int(fmt_tags["time_reference"])
    p.timecode = fmt_tags.get("timecode")
    for s in info.get("streams", []):
        tags = {k.lower(): v for k, v in s.get("tags", {}).items()}
        p.timecode = p.timecode or tags.get("timecode")  # video stream or tmcd data stream
        if s.get("codec_type") == "video" and p.fps is None and s.get("disposition", {}).get("attached_pic") != 1:
            p.fps = Fraction(s.get("r_frame_rate", "0/1"))
            p.width, p.height = int(s.get("width", 0)), int(s.get("height", 0))
        elif s.get("codec_type") == "audio" and not p.audio_rate:
            p.audio_rate, p.audio_channels = int(s.get("sample_rate", 0)), int(s.get("channels", 0))
    return p


# ── pass 1: timecode ──────────────────────────────────────────────────────────

def tc_to_seconds(tc: str, fps: Fraction) -> float:
    """HH:MM:SS:FF (or ;FF drop-frame) → seconds since midnight."""
    drop = ";" in tc
    hh, mm, ss, ff = (int(x) for x in tc.replace(";", ":").split(":"))
    nominal = round(float(fps))
    frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff
    if drop:  # SMPTE drop-frame: 2 (or 4 at 59.94) frame numbers skipped each minute except every tenth
        skip = round(nominal / 15)
        minutes = hh * 60 + mm
        frames -= skip * (minutes - minutes // 10)
    return frames / float(fps)


def timecode_starts(probes: list[Probe], video_fps: Fraction) -> dict[Path, float] | None:
    """Start of each file on a shared time-of-day clock, or None if timecode can't be trusted."""
    starts: dict[Path, float] = {}
    for p in probes:
        if p.timecode:
            starts[p.path] = tc_to_seconds(p.timecode, p.fps or video_fps)
        elif p.time_reference is not None and p.audio_rate:
            starts[p.path] = p.time_reference / p.audio_rate
        else:
            return None
    values = list(starts.values())
    if all(v == 0 for v in values):
        return None  # default 00:00:00:00 on every file: nothing was jammed
    if max(values) - min(values) > max(p.duration for p in probes):
        return None  # files wouldn't overlap: clocks weren't in sync
    return starts


# ── pass 2: waveform ──────────────────────────────────────────────────────────

def read_audio(path: Path, rate: int, start: float = 0.0, duration: float | None = None, channel: int | None = None) -> np.ndarray:
    """Mono float32 samples. channel=None mixes all channels down."""
    args = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error"]
    if start > 0:
        args += ["-ss", f"{start:.4f}"]          # before -i: seek by index, fetch only this window
    args += ["-i", str(path)]
    if duration is not None:
        args += ["-t", f"{duration:.4f}"]
    mix = ["-ac", "1"] if channel is None else ["-af", f"pan=mono|c0=c{channel}"]
    args += ["-vn", "-map", "0:a:0", *mix, "-ar", str(rate), "-f", "f32le", "-"]
    proc = subprocess.run(args, capture_output=True)
    if proc.returncode != 0:
        raise MediaError(f"ffmpeg could not read audio from {path.name}: {proc.stderr.decode(errors='replace')[-300:]}")
    return np.frombuffer(proc.stdout, dtype=np.float32)


def mic_mix(paths: list[Path], rate: int, start: float = 0.0, duration: float | None = None) -> np.ndarray:
    """Sum of the mic stems (channel 1 of each), so every speaker is in the reference."""
    parts = [read_audio(p, rate, start, duration, channel=0) for p in paths]
    out = np.zeros(max(len(x) for x in parts), dtype=np.float32)
    for x in parts:
        out[: len(x)] += x
    return out


def _prep(x: np.ndarray, rate: int) -> np.ndarray:
    """Speech band only, zero mean, unit variance: different mics then correlate on the voice, not the room."""
    if len(x) < rate // 10:
        return x.astype(np.float64)
    sos = butter(4, [200, min(3400, rate * 0.45)], btype="bandpass", fs=rate, output="sos")
    y = sosfiltfilt(sos, x.astype(np.float64))
    sd = y.std()
    return (y - y.mean()) / sd if sd > 0 else y


@dataclass
class Match:
    at: float    # seconds into the reference where the signal's first sample sits
    psr: float   # peak-to-sidelobe ratio; > MIN_PSR is a confident match


def locate(sig: np.ndarray, ref: np.ndarray, rate: int) -> Match:
    """Where sig best lines up inside ref, by cross-correlation (scipy fftconvolve with sig reversed)."""
    if len(sig) == 0 or len(ref) == 0:
        return Match(0.0, 0.0)
    c = np.abs(fftconvolve(ref, sig[::-1], mode="full"))  # |polarity| doesn't matter between mics
    k = int(np.argmax(c))
    frac = 0.0
    if 0 < k < len(c) - 1:  # parabolic interpolation of the peak: sub-sample precision
        y0, y1, y2 = c[k - 1], c[k], c[k + 1]
        denom = y0 - 2 * y1 + y2
        frac = 0.5 * (y0 - y2) / denom if denom else 0.0
    guard = max(1, int(0.05 * rate))  # ignore the main lobe when measuring the noise floor
    side = np.concatenate([c[: max(0, k - guard)], c[k + guard + 1:]])
    psr = float((c[k] - side.mean()) / side.std()) if len(side) > 10 and side.std() > 0 else 0.0
    return Match(at=(k + frac - (len(sig) - 1)) / rate, psr=psr)


@dataclass
class Placement:
    path: Path
    start: float                  # seconds on the session timeline (>= 0 after normalising)
    method: str                   # timecode | waveform | same-recorder | unsynced
    confidence: float = 0.0       # PSR for waveform matches
    drift_ppm: float | None = None
    duration: float = 0.0


@dataclass
class SyncResult:
    cameras: list[Placement]
    mics: list[Placement]
    duration: float
    fps: Fraction
    warnings: list[str] = field(default_factory=list)

    @property
    def needs_review(self) -> bool:
        return any(p.method == "unsynced" for p in self.cameras + self.mics) or bool(self.warnings)


def _verify_offset(cam: Probe, mics: list[Path], cand_start: float, t0: float, win: float, mic_dur: float) -> bool:
    """Confirm a candidate start offset on a second, disjoint window of the camera file."""
    dur = cam.duration
    if dur < 120.0 or mic_dur < 120.0:
        return True
    vwin = min(30.0, dur * 0.2)
    t_ver = min(dur - vwin - 5.0, t0 + 300.0) if t0 + 300.0 + vwin < dur else max(0.0, t0 - 300.0)
    if abs(t_ver - t0) < win:
        return True
    expected = cand_start + t_ver
    if expected < -5.0 or expected + vwin > mic_dur + 5.0:
        return False
    v0 = max(0.0, expected - 5.0)
    sig = _prep(read_audio(cam.path, COARSE_RATE, t_ver, vwin), COARSE_RATE)
    ref = _prep(mic_mix(mics, COARSE_RATE, v0, vwin + 10.0), COARSE_RATE)
    m = locate(sig, ref, COARSE_RATE)
    return m.psr >= MIN_PSR and abs((v0 + m.at - t_ver) - cand_start) <= 1.0


def _find_camera(
    cam: Probe,
    mics: list[Path],
    guess: float | None,
    coarse_ref: np.ndarray | None = None,
    mic_dur: float | None = None,
) -> tuple[float, float, float | None]:
    """(camera start on the mic timeline, PSR, drift ppm) by waveform."""
    dur = cam.duration
    win = min(WINDOW_S, dur * 0.5)
    if mic_dur is None:
        mic_dur = max(probe(m).duration for m in mics)

    t0 = min(60.0, dur * 0.25)
    hit, best_t0, best_psr = None, t0, 0.0

    if guess is not None:
        sig = _prep(read_audio(cam.path, COARSE_RATE, t0, win), COARSE_RATE)
        r0 = max(0.0, guess + t0 - PRIOR_MARGIN_S)
        ref = _prep(mic_mix(mics, COARSE_RATE, r0, win + 2 * PRIOR_MARGIN_S), COARSE_RATE)
        coarse = locate(sig, ref, COARSE_RATE)
        if coarse.psr < MIN_PSR:
            return _find_camera(cam, mics, None, coarse_ref=coarse_ref, mic_dur=mic_dur)
        hit, best_t0, best_psr = r0 + coarse.at, t0, coarse.psr
    else:
        if coarse_ref is None:
            coarse_ref = _prep(mic_mix(mics, COARSE_RATE), COARSE_RATE)
        anchors = []
        for a in (min(60.0, dur * 0.25), min(300.0, dur * 0.4), min(1200.0, dur * 0.65)):
            if all(abs(a - prev) >= 30.0 for prev in anchors) and a + win <= dur:
                anchors.append(a)
        if not anchors:
            anchors = [t0]

        for a in anchors:
            sig = _prep(read_audio(cam.path, COARSE_RATE, a, win), COARSE_RATE)
            coarse = locate(sig, coarse_ref, COARSE_RATE)
            if coarse.psr < MIN_PSR:
                continue
            cand_start = coarse.at - a
            if _verify_offset(cam, mics, cand_start, a, win, mic_dur):
                hit, best_t0, best_psr = coarse.at, a, coarse.psr
                break
            if coarse.psr > best_psr:
                hit, best_t0, best_psr = coarse.at, a, coarse.psr

        if hit is None:
            return 0.0, best_psr, None

    # Fine: 16 kHz, ±0.25 s around the coarse hit.
    fwin = min(FINE_WINDOW_S, win)
    pad = 0.25
    sig = _prep(read_audio(cam.path, FINE_RATE, best_t0, fwin), FINE_RATE)
    f0 = max(0.0, hit - pad)
    fine = locate(sig, _prep(mic_mix(mics, FINE_RATE, f0, fwin + 2 * pad), FINE_RATE), FINE_RATE)
    start = (f0 + fine.at) - best_t0 if fine.psr >= MIN_PSR else hit - best_t0

    # Drift: the same fine search near the end of the camera file.
    drift = None
    t1 = dur - min(120.0, dur * 0.2) - fwin
    if t1 - best_t0 > 300:
        sig = _prep(read_audio(cam.path, FINE_RATE, t1, fwin), FINE_RATE)
        e0 = max(0.0, start + t1 - 0.5)
        end = locate(sig, _prep(mic_mix(mics, FINE_RATE, e0, fwin + 1.0), FINE_RATE), FINE_RATE)
        if end.psr >= MIN_PSR:
            drift = ((e0 + end.at - t1) - start) / (t1 - best_t0) * 1e6
    return start, max(best_psr, fine.psr), drift


def sync_session(cameras: list[Path], mics: list[Path], priors: dict[Path, float] | None = None) -> SyncResult:
    """Place every camera and mic on one timeline.

    priors: optional rough start times (seconds, any shared origin) from file
    names or creation times; they narrow the waveform search to ±15 s.
    """
    cam_probes = [probe(p) for p in cameras]
    mic_probes = [probe(p) for p in mics]
    fps = next((p.fps for p in cam_probes if p.fps), None)
    if not fps:
        raise MediaError("None of the camera files has a video stream.")
    warnings: list[str] = []

    tc = timecode_starts(cam_probes + mic_probes, fps)
    if tc is not None:
        cam_places = [Placement(p.path, tc[p.path], "timecode", 1.0, duration=p.duration) for p in cam_probes]
        mic_places = [Placement(p.path, tc[p.path], "timecode", 1.0, duration=p.duration) for p in mic_probes]
    else:
        # Mics: stems of one multitrack recording share a clock; anything else is lined up on mic 1.
        ref = mic_probes[0]
        mic_places = [Placement(ref.path, 0.0, "same-recorder", 1.0, duration=ref.duration)]
        for m in mic_probes[1:]:
            if abs(m.duration - ref.duration) <= SAME_RECORDER_S:
                mic_places.append(Placement(m.path, 0.0, "same-recorder", 1.0, duration=m.duration))
                continue
            match = locate(_prep(read_audio(m.path, COARSE_RATE, channel=0), COARSE_RATE),
                           _prep(read_audio(ref.path, COARSE_RATE, channel=0), COARSE_RATE), COARSE_RATE)
            ok = match.psr >= MIN_PSR
            mic_places.append(Placement(m.path, match.at if ok else 0.0, "waveform" if ok else "unsynced", match.psr, duration=m.duration))
            if not ok:
                warnings.append(f"{m.path.name}: couldn't line up with {ref.path.name}; left at 0.")

        # Cameras: each found inside the mix of the stems that share mic 1's clock.
        anchor = [m.path for m in mic_places if m.start == 0.0 and m.method != "unsynced"]
        mic_dur = max(m.duration for m in mic_places if m.path in anchor)
        coarse_ref = None
        mic_prior = (priors or {}).get(ref.path)
        cam_places = []
        for c in cam_probes:
            guess = None
            if priors and c.path in priors and mic_prior is not None:
                guess = priors[c.path] - mic_prior
            if guess is None and coarse_ref is None:
                coarse_ref = _prep(mic_mix(anchor, COARSE_RATE), COARSE_RATE)
            start, psr, drift = _find_camera(c, anchor, guess, coarse_ref=coarse_ref, mic_dur=mic_dur)
            ok = psr >= MIN_PSR
            cam_places.append(Placement(c.path, start, "waveform" if ok else "unsynced", psr, drift, c.duration))
            if not ok:
                warnings.append(f"{c.path.name}: no confident audio match (PSR {psr:.1f}); placed at 0 for manual sync.")
            if drift is not None and abs(drift) * c.duration / 1e6 > 0.5 / float(fps):
                warnings.append(f"{c.path.name}: drifts {drift:+.0f} ppm (~{drift * c.duration / 1e6 * float(fps):+.1f} frames by the end).")

    # Shift so the earliest file starts at 0.
    origin = min(p.start for p in cam_places + mic_places)
    for p in cam_places + mic_places:
        p.start -= origin
    duration = max(p.start + p.duration for p in cam_places + mic_places)
    return SyncResult(cam_places, mic_places, duration, fps, warnings)
