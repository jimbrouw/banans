import os
import subprocess

import pytest

from roughcut_engine.transcribe import flatten, transcribe

RAW = {
    "language": "en",
    "segments": [
        {"start": 0.0, "end": 2.4, "text": " Um, welcome back.", "words": [
            {"word": " Um,", "start": 0.0, "end": 0.31, "probability": 0.9},
            {"word": " welcome", "start": 0.5, "end": 0.9, "probability": 0.99},
            {"word": " back.", "start": 0.9, "end": 1.2, "probability": 0.98},
        ]},
        {"start": 2.4, "end": 3.0, "text": " Like, uh", "words": [
            {"word": " Like,", "start": 2.4, "end": 2.6, "probability": 0.8},
            {"word": " uh", "start": 2.7, "end": 3.0, "probability": 0.7},
            {"word": " ", "start": 3.0, "end": 3.0, "probability": 0.1},
        ]},
    ],
}


def test_flatten_tags_hard_fillers_only():
    out = flatten(RAW)
    assert out["language"] == "en"
    assert [s["text"] for s in out["segments"]] == ["Um, welcome back.", "Like, uh"]
    assert [(w["text"], w["filler"], w["segment"]) for w in out["words"]] == [
        ("Um,", True, 0), ("welcome", False, 0), ("back.", False, 0),
        ("Like,", False, 1), ("uh", True, 1),
    ]


@pytest.mark.slow
@pytest.mark.skipif(not os.environ.get("RC_ENGINE_SLOW"), reason="set RC_ENGINE_SLOW=1 to run real transcription")
def test_real_transcription_with_say(tmp_path):
    aiff = tmp_path / "speech.aiff"
    subprocess.run(["say", "-o", str(aiff), "Welcome back to the show. Today we are talking about editing."], check=True)
    result = transcribe(str(aiff), model=os.environ.get("RC_TEST_MODEL", "mlx-community/whisper-tiny"))
    text = " ".join(w["text"] for w in result["words"]).lower()
    assert "welcome" in text and "editing" in text
    starts = [w["start"] for w in result["words"]]
    assert starts == sorted(starts)
    # Second call hits the cache
    assert transcribe(str(aiff), model=result["model"]) == result
