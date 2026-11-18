import subprocess

import pytest
from fastapi.testclient import TestClient

from roughcut_engine.app import app
from roughcut_engine.levels import levels


@pytest.fixture
def two_mics(tmp_path):
    """Stereo file: left mic talks 0-2s, right mic talks 2-4s (each silent otherwise)."""
    out = tmp_path / "mics.wav"
    tone = "sine=frequency=300:duration=2"
    quiet = "anullsrc=r=48000:cl=mono:d=2"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", tone, "-f", "lavfi", "-i", quiet,
        "-f", "lavfi", "-i", quiet, "-f", "lavfi", "-i", tone,
        "-filter_complex",
        "[0:a]aresample=48000[t0];[3:a]aresample=48000[t3];[t0][1:a]concat=n=2:v=0:a=1[l];[2:a][t3]concat=n=2:v=0:a=1[r];[l][r]join=inputs=2:channel_layout=stereo",
        str(out),
    ], check=True)
    return out


def test_channel_levels_follow_each_mic(two_mics):
    left = levels(str(two_mics), channel=0)
    right = levels(str(two_mics), channel=1)
    assert left["rate"] == 10 and left["duration"] == pytest.approx(4, abs=0.05)
    assert len(left["db"]) == 40
    # Left loud then silent, right the opposite.
    assert min(left["db"][2:18]) > -25 and max(left["db"][22:38]) < -80
    assert max(right["db"][2:18]) < -80 and min(right["db"][22:38]) > -25


def test_mix_and_route(two_mics):
    mix = TestClient(app).post("/levels", json={"path": str(two_mics)}).json()
    assert mix["channel"] is None and min(mix["db"][2:38]) > -30
    assert TestClient(app).post("/levels", json={"path": "/nope.wav"}).status_code == 400
