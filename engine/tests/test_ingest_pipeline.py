from fractions import Fraction
from pathlib import Path
import struct
import numpy as np
import pytest

from roughcut_engine.sync import locate, tc_to_seconds, timecode_starts, Probe
from roughcut_engine.xml_builder import Builder, Source, Shot
from roughcut_engine.auto_cut import (
    auto_cut,
    detect_speakers,
    generate_cut_map,
    evaluate_cut_map,
    CameraPlan,
    Segment,
    Profile,
    cuts_to_intervals,
)
from roughcut_engine.lucid_watcher import wav_closed, mp4_closed, Batch, State, StateStore


def test_correlate_synthetic_delay():
    rate = 4000
    np.random.seed(42)
    noise = np.random.randn(2 * rate).astype(np.float32)
    ref = np.zeros(6 * rate, dtype=np.float32)
    delay_samples = int(1.5 * rate)
    ref[delay_samples : delay_samples + len(noise)] = noise

    match = locate(noise, ref, rate)
    assert abs(match.at - 1.5) < 0.005
    assert match.psr > 15.0


def test_timecode_math():
    fps = Fraction(30000, 1001)  # 29.97
    sec_df = tc_to_seconds("01;00;00;00", fps)
    assert round(sec_df) == 3600

    sec_ndf = tc_to_seconds("01:00:00:00", fps)
    assert round(sec_ndf) == 3604

    p1 = Probe(path=Path("cam1.mp4"), duration=60.0, timecode="01:00:00:00", fps=fps)
    p2 = Probe(path=Path("cam2.mp4"), duration=60.0, timecode="01:00:05:00", fps=fps)
    starts = timecode_starts([p1, p2], fps)
    assert starts is not None
    assert round(starts[p2.path] - starts[p1.path]) == 5


def test_xml_builder_validity(tmp_path):
    fps = Fraction(30000, 1001)
    b = Builder(fps=fps, width=1920, height=1080)
    cams = [Source(id=f"cam{i}", path=Path(f"/test/cam{i}.mp4"), kind="video", duration=30.0, start=0.0) for i in (1, 2, 3)]
    mics = [Source(id=f"mic{i}", path=Path(f"/test/mic{i}.wav"), kind="audio", duration=30.0, start=0.0) for i in (1, 2, 3)]

    shots = [
        Shot(start=0, end=300, camera="cam1", reason="speaker"),
        Shot(start=300, end=600, camera="cam2", reason="speaker"),
        Shot(start=600, end=900, camera="cam3", reason="crosstalk"),
    ]
    b.synced_stack("Stack", cams, mics)
    b.auto_cut("Cut", cams, mics, shots)

    out = tmp_path / "test.xml"
    b.write(out)
    text = out.read_text()

    assert "<xmeml version=\"4\">" in text
    assert "<name>Stack</name>" in text
    assert "<name>Cut</name>" in text
    assert "file://localhost/test/cam1.mp4" in text
    assert "<enabled>TRUE</enabled>" in text
    assert "<enabled>FALSE</enabled>" in text


def test_auto_cut_rules():
    segments = [
        Segment(speaker=0, start=0.0, end=10.0),
        Segment(speaker=1, start=10.0, end=20.0),
    ]
    plan = CameraPlan(camera_for_mic=[0, 1, 2], wide=2, coverage=[(0, 30), (0, 30), (0, 30)])
    profile = Profile("Balanced", min_shot=2.5, aggressiveness="medium", reaction_after=15.0, reaction_len=2.5)
    cuts = generate_cut_map(segments, plan, profile, total_frames=600, fps=29.97)

    assert len(cuts) >= 2
    assert cuts[0].camera == 0
    assert cuts[1].camera == 1

    score, checks = evaluate_cut_map(cuts, segments, plan, profile, total_frames=600, fps=29.97)
    assert score >= 75


def test_container_checks(tmp_path):
    data_size = 1000
    riff_size = data_size + 36
    hdr = b"RIFF" + struct.pack("<I", riff_size) + b"WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80>\x00\x00\x00}\x00\x00\x02\x00\x10\x00data" + struct.pack("<I", data_size)
    full_wav = hdr + (b"\x00" * data_size)
    ok, dur = wav_closed(full_wav, len(full_wav))
    assert ok is True

    ok_bad, _ = wav_closed(full_wav, len(full_wav) + 500)
    assert ok_bad is False


def test_state_store(tmp_path):
    db_file = tmp_path / "ingest.db"
    store = StateStore(db_file)
    batch = Batch(key="2026-10-26 12-00-00", state=State.DISCOVERED)
    store.save(batch)

    loaded = store.load()
    assert "2026-10-26 12-00-00" in loaded
    assert loaded["2026-10-26 12-00-00"].state == State.DISCOVERED


def test_find_masters_matching(tmp_path):
    from roughcut_engine.lucid_watcher import find_masters_for_batch, WatchConfig
    from roughcut_engine.config import IngestConfig

    masters_dir = tmp_path / "Just-In Masters"
    masters_dir.mkdir(parents=True)
    # create sample master mov files
    (masters_dir / "27_143740_Channel1.mov").touch()
    (masters_dir / "27_143741_Channel2.mov").touch()
    (masters_dir / "27_143741_Channel3.mov").touch()
    (masters_dir / "27_101746_Channel1.mov").touch()

    cfg = WatchConfig(mount=tmp_path)
    user_cfg = IngestConfig(masters_cloud_dir=str(masters_dir.relative_to(tmp_path)))
    batch = Batch(key="2026-10-27 14-37-42", state=State.DISCOVERED)

    matches = find_masters_for_batch(batch, cfg, user_cfg)
    assert len(matches) == 3
    assert matches[0][0] == "Channel1"
    assert matches[0][1].name == "27_143740_Channel1.mov"
    assert matches[1][0] == "Channel2"
    assert matches[2][0] == "Channel3"


def test_xml_builder_in_point_clap_offset(tmp_path):
    fps = Fraction(30000, 1001)
    b = Builder(fps=fps, width=1920, height=1080)
    cams = [Source(id=f"cam{i}", path=Path(f"/test/cam{i}.mp4"), kind="video", duration=30.0, start=0.0, in_point=1.0) for i in (1, 2, 3)]
    # Mics with 11 frames offset
    mics = [Source(id=f"mic{i}", path=Path(f"/test/mic{i}.wav"), kind="audio", duration=30.0, start=0.0, in_point=11/float(fps)) for i in (1, 2, 3)]

    shots = [Shot(start=0, end=300, camera="cam1", reason="speaker")]
    b.synced_stack("Stack", cams, mics)
    b.auto_cut("Cut", cams, mics, shots)

    out = tmp_path / "test_clap.xml"
    b.write(out)
    text = out.read_text()
    assert "<in>11</in>" in text
