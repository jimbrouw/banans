"""ffmpeg helpers and the on-disk result cache."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

CACHE_DIR = Path(os.environ.get("RC_ENGINE_CACHE", Path.home() / "Library/Caches/roughcut-engine"))


class MediaError(Exception):
    pass


def require_file(path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_file():
        raise MediaError(f"File not found: {path}")
    return p


def cache_key(path: Path, kind: str, params: dict) -> str:
    """Key on path + size + mtime so an edited/replaced file is re-analysed."""
    st = path.stat()
    raw = json.dumps([str(path.resolve()), st.st_size, st.st_mtime_ns, kind, params], sort_keys=True)
    return hashlib.sha1(raw.encode()).hexdigest()


def cache_get(key: str) -> dict | None:
    f = CACHE_DIR / f"{key}.json"
    return json.loads(f.read_text()) if f.is_file() else None


def cache_put(key: str, value: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{key}.json").write_text(json.dumps(value))


def run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-5:])
        raise MediaError(f"ffmpeg failed: {tail}")
    return proc


def duration_seconds(path: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError as e:
        raise MediaError(f"Could not read duration of {path}") from e


def extract_wav(path: Path, key: str) -> Path:
    """16 kHz mono WAV of the first audio stream — what whisper wants. Cached."""
    out = CACHE_DIR / f"{key}.wav"
    if not out.is_file():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        run_ffmpeg(["-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)])
    return out
