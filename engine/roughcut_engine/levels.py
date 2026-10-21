"""Loudness over time for one mic: the input for Podcast Mode's active-speaker detection.

Returns one dB value per 1/rate seconds. Deciding who's talking happens in the
panel, after every mic is placed on the same sequence timeline.
"""

import subprocess

import numpy as np

from .media import MediaError, cache_get, cache_key, cache_put, require_file

SAMPLE_RATE = 8000
FLOOR_DB = -100.0


def rms_db(samples: np.ndarray, rate: int) -> list[float]:
    window = SAMPLE_RATE // rate
    n = len(samples) // window
    if n == 0:
        return []
    frames = samples[: n * window].reshape(n, window)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    db = 20 * np.log10(np.maximum(rms, 10 ** (FLOOR_DB / 20)))
    return [round(float(v), 1) for v in db]


def levels(path: str, channel: int | None = None, rate: int = 10) -> dict:
    p = require_file(path)
    params = {"channel": channel, "rate": rate}
    key = cache_key(p, "levels", params)
    if cached := cache_get(key):
        return cached

    # One channel of a multi-mic recording, or the whole file mixed down.
    mix = ["-af", f"pan=mono|c0=c{channel}"] if channel is not None else ["-ac", "1"]
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(p), "-vn", *mix, "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.decode(errors="replace").strip().splitlines()[-3:])
        raise MediaError(f"ffmpeg failed: {tail}")
    samples = np.frombuffer(proc.stdout, dtype=np.float32)
    db = rms_db(samples, rate)
    result = {"rate": rate, "channel": channel, "duration": round(len(samples) / SAMPLE_RATE, 3), "db": db}
    cache_put(key, result)
    return result
