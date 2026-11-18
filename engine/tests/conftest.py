import subprocess

import pytest


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    from roughcut_engine import media
    monkeypatch.setattr(media, "CACHE_DIR", tmp_path / "cache")


@pytest.fixture
def tone_with_gap(tmp_path):
    """2s tone, 1.5s silence, 2s tone, 1s silence → 6.5s file."""
    out = tmp_path / "gap.wav"
    tone = "sine=frequency=440:duration=2"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", tone,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1.5",
        "-f", "lavfi", "-i", tone,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
        "-filter_complex", "[0:a]aresample=48000[a0];[2:a]aresample=48000[a2];[a0][1:a][a2][3:a]concat=n=4:v=0:a=1",
        str(out),
    ], check=True)
    return out
