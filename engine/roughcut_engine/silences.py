"""Silence detection on the real audio via ffmpeg's silencedetect filter."""

import re

from .media import cache_get, cache_key, cache_put, duration_seconds, require_file, run_ffmpeg

_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


def parse_silencedetect(stderr: str, duration: float) -> list[dict]:
    """Turn silencedetect log lines into [{start, end}] ranges in seconds.

    A trailing silence has a start but no end; it runs to the end of the file.
    """
    ranges: list[dict] = []
    start: float | None = None
    for line in stderr.splitlines():
        if m := _START.search(line):
            start = max(0.0, float(m.group(1)))
        elif (m := _END.search(line)) and start is not None:
            ranges.append({"start": round(start, 3), "end": round(float(m.group(1)), 3)})
            start = None
    if start is not None and duration > start:
        ranges.append({"start": round(start, 3), "end": round(duration, 3)})
    return ranges


def detect_silences(path: str, noise_db: float = -35.0, min_silence: float = 0.5) -> dict:
    p = require_file(path)
    params = {"noise_db": noise_db, "min_silence": min_silence}
    key = cache_key(p, "silences", params)
    if cached := cache_get(key):
        return cached

    duration = duration_seconds(p)
    proc = run_ffmpeg([
        "-i", str(p), "-vn",
        "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}",
        "-f", "null", "-",
    ])
    result = {"duration": round(duration, 3), **params, "silences": parse_silencedetect(proc.stderr, duration)}
    cache_put(key, result)
    return result
