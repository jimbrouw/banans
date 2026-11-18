import pytest

from roughcut_engine.media import MediaError
from roughcut_engine.silences import detect_silences, parse_silencedetect

LOG = """
[silencedetect @ 0x1] silence_start: -0.002
[silencedetect @ 0x1] silence_end: 0.8 | silence_duration: 0.8
[silencedetect @ 0x1] silence_start: 4.25
[silencedetect @ 0x1] silence_end: 5.5 | silence_duration: 1.25
[silencedetect @ 0x1] silence_start: 9.1
"""


def test_parse_pairs_starts_and_ends_and_runs_trailing_silence_to_duration():
    assert parse_silencedetect(LOG, duration=10.0) == [
        {"start": 0.0, "end": 0.8},
        {"start": 4.25, "end": 5.5},
        {"start": 9.1, "end": 10.0},
    ]


def test_parse_empty_log():
    assert parse_silencedetect("", duration=5.0) == []


def test_detect_on_real_audio(tone_with_gap):
    result = detect_silences(str(tone_with_gap), min_silence=0.5)
    assert result["duration"] == pytest.approx(6.5, abs=0.05)
    gaps = result["silences"]
    assert len(gaps) == 2
    assert gaps[0]["start"] == pytest.approx(2.0, abs=0.05)
    assert gaps[0]["end"] == pytest.approx(3.5, abs=0.05)
    assert gaps[1]["start"] == pytest.approx(5.5, abs=0.05)
    assert gaps[1]["end"] == pytest.approx(6.5, abs=0.05)


def test_min_silence_filters_short_gaps(tone_with_gap):
    assert len(detect_silences(str(tone_with_gap), min_silence=1.2)["silences"]) == 1


def test_missing_file():
    with pytest.raises(MediaError, match="File not found"):
        detect_silences("/nope/missing.wav")
