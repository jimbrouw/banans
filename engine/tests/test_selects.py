import pytest
from fastapi.testclient import TestClient

from roughcut_engine.app import app
from roughcut_engine.edit import EditError, Unit
from roughcut_engine.selects import (CANDIDATE_SYSTEM, CHAPTER_SYSTEM, JUDGE_SYSTEM, build, run_chapters,
                                     run_selects, weak_opening)

# 60 sentences, 3 s each with a 0.3 s breath: line i runs i*3.3 .. i*3.3+3.
UNITS = [Unit(i, round(i * 3.3, 2), round(i * 3.3 + 3, 2), f"Line {i} about topic {i // 10}.") for i in range(60)]
UNITS[20] = Unit(20, 66.0, 69.0, "You will never guess why 90% of riders quit in year one.")
BY_ID = {u.id: u for u in UNITS}


def cand(first, last, hook=-1, type_="story", idea=None, title="Working title 12"):
    return {"first": first, "last": last, "hook_line": hook, "type": type_, "idea": idea or f"idea {first}", "title": title, "why": "Because."}


def test_build_checks_length_and_ids():
    assert build(cand(0, 9), BY_ID).duration == pytest.approx(32.7, abs=0.1)  # contiguous lines merge, 0.3 s breaths kept
    short = build(cand(0, 2), BY_ID)            # under 20 s: carried on through the next lines to finish the thought
    assert short.last == 6 and 20 <= short.duration <= 23
    assert build(cand(0, 30), BY_ID) is None   # over 60 s
    assert build(cand(9, 3), BY_ID) is None    # backwards
    assert build(cand(0, 999), BY_ID) is None  # unknown id


def test_build_does_not_extend_across_a_long_pause():
    units = {u.id: u for u in UNITS}
    units[3] = Unit(3, 20.0, 23.0, "After a long pause.")  # 13 s gap after line 2
    assert build(cand(0, 2), units) is None


def test_build_pulls_a_hook_forward():
    c = build(cand(10, 18, hook=20), BY_ID)  # line 20 starts 3 s after line 18 ends: within reach
    assert c.hook == 20 and c.opening.startswith("You will never guess")
    assert c.pieces[0] == (66.0, 69.0) and c.pieces[1][0] == 33.0
    far = build(cand(0, 8, hook=40), BY_ID)  # 100+ s away: not the same passage
    assert far.hook is None and far.pieces[0][0] == 0.0


@pytest.mark.parametrize("text", [
    "Um, so the thing is this.", "Like, honestly it was wild.", "Well, I guess so.",
    "Yeah, exactly.", "Right, and that's why.", "He told me never to do it.", "They never called back.",
    "As I said before, it matters.", "Going back to that point, it matters.", "We talked about this before we started recording.",
])
def test_weak_openings_are_caught(text):
    assert weak_opening(text)


@pytest.mark.parametrize("text", [
    "I never told anyone this.", "Likewise, the team agreed.", "Wellington is where it started.",
    "Rightly so, nobody believed her.", "The biggest mistake was hiring too fast.", "Then she quit.",
])
def test_good_openings_are_left_alone(text):
    assert not weak_opening(text)


def with_texts(**changes):
    units = {u.id: u for u in UNITS}
    for i, text in changes.items():
        u = units[int(i[1:])]
        units[u.id] = Unit(u.id, u.start, u.end, text)
    return units


def test_weak_opening_moves_back_to_a_full_sentence():
    c = build(cand(10, 18), with_texts(u10="Yeah, exactly that."))
    assert c.first == 9 and not c.weak_opening and c.pieces[0][0] == BY_ID[9].start
    assert c.proposed == (10, 18)
    # Two lines back is as far as it goes: still weak means keep the clip as the model chose it and flag it.
    stuck = build(cand(10, 18), with_texts(u10="Yeah, exactly.", u9="Right.", u8="Totally."))
    assert stuck.first == 10 and stuck.weak_opening


def test_weak_opening_does_not_cross_a_long_pause_or_the_length_limit():
    units = with_texts(u10="He said no.")
    units[9] = Unit(9, 20.0, 23.0, "Earlier, after a pause.")        # 10 s before line 10 starts
    assert build(cand(10, 18), units).first == 10
    c = build(cand(10, 27), with_texts(u10="He said no."))            # 18 lines is 59 s: one more would pass 60
    assert c.first == 10 and c.weak_opening


def test_a_pulled_forward_hook_is_flagged_not_moved():
    c = build(cand(10, 18, hook=20), with_texts(u20="Yeah, you will never guess why."))
    assert c.first == 10 and c.hook == 20 and c.weak_opening


def test_ending_runs_on_to_a_full_sentence():
    c = build(cand(10, 18), with_texts(u18="and then she said that"))
    assert c.last == 19


def test_ending_goes_back_when_the_speech_stops():
    units = with_texts(u18="and then she said that")
    units[19] = Unit(19, 80.0, 83.0, "After a long pause.")           # 14 s gap: not the same breath
    c = build(cand(10, 18), units)
    assert c.last == 17


def test_unpunctuated_transcripts_keep_their_endings():
    units = {u.id: Unit(u.id, u.start, u.end, u.text.rstrip(".")) for u in UNITS}
    c = build(cand(10, 18), units)
    assert c.last == 18


def fake_ask(candidates, chapter_titles=None):
    calls = {"judge": 0}

    def ask(system, user, schema):
        if system == CANDIDATE_SYSTEM:
            return {"candidates": candidates}
        if system == JUDGE_SYSTEM:
            calls["judge"] += 1
            a, b = user.split("Clip B:")
            return {"winner": "A" if "WIN" in a or ("WIN" not in b and len(a) > len(b)) else "B", "reason": "r"}
        if system == CHAPTER_SYSTEM:
            return {"titles": chapter_titles or []}
        raise AssertionError(system)
    return ask, calls


def test_selects_ranks_dedupes_and_mixes_types(monkeypatch):
    units = list(UNITS)
    units[45] = Unit(45, 148.5, 151.5, "WIN line that every judge prefers.")
    ask, calls = fake_ask([
        cand(0, 9, type_="story", idea="Quitting early"),
        cand(3, 12, type_="story", idea="Overlaps the first"),        # >30% overlap with the first: dropped
        cand(10, 18, hook=20, type_="opinion"),
        cand(40, 48, type_="tip"),                                     # contains the WIN line
        cand(30, 38, type_="moment", idea="quitting early!"),          # same idea as the first: dropped
        cand(58, 59, type_="tip"),                                     # too short, nothing after it to extend into: dropped
        cand(5, 999),                                                  # invalid: dropped
    ])
    out = run_selects(units, ask, audio_db=[-20.0] * 2000)
    assert out["proposed"] == 7 and out["valid"] == 5 and out["shortlisted"] == 3
    assert calls["judge"] > 0
    clips = out["clips"]
    assert [c["rank"] for c in clips] == [1, 2, 3]
    assert clips[0]["lines"] == [40, 48]                      # won its comparisons
    assert {c["type"] for c in clips} == {"story", "opinion", "tip"}
    opinion = next(c for c in clips if c["type"] == "opinion")
    assert opinion["hook_pulled_forward"] and opinion["pieces"][0] == {"start": 66.0, "end": 69.0}
    for c in clips:
        assert 20 <= c["duration"] <= 60
        assert {"verdict", "band", "weakest", "fix", "formula"} <= set(c["hook_score"])
        assert "score" in c["title_check"] and c["energy"] is not None


def test_swiss_rotates_the_sit_out_and_avoids_rematches():
    from roughcut_engine.selects import Candidate, swiss
    cs = [Candidate(i, i, None, "story", f"i{i}", "t", "w", pieces=[(i * 100.0, i * 100 + 30.0)], text=f"clip {i}" + (" WIN" if i == 2 else "")) for i in range(3)]
    for c, v in zip(cs, (60, 50, 40)):
        c.hook_score = {"verdict": v}
    meetings = []

    def ask(system, user, schema):
        meetings.append(user)
        a, _ = user.split("Clip B:")
        return {"winner": "A" if "WIN" in a else "B" if "WIN" in user else "A", "reason": ""}
    swiss(cs, ask, rounds=3)
    assert len(meetings) == 3 and len(set(meetings)) == 3   # a round robin: everyone met everyone once
    assert cs[2].wins == 2                                   # the best clip got to play and won both


def test_selects_needs_a_transcript():
    with pytest.raises(EditError, match="Not enough transcript"):
        run_selects(UNITS[:5], fake_ask([])[0])


def test_chapters_are_valid_and_retitled():
    long_units = [Unit(i, i * 12.0, i * 12.0 + 11, f"Section {i // 15} words {'alpha beta gamma delta'.split()[i // 15 % 4]}.") for i in range(180)]
    out = run_chapters(long_units, fake_ask([], chapter_titles=["Why riders quit", "", "The first race"])[0])
    assert out["valid"] and out["chapters"][0]["label"] == "0:00"
    assert 6 <= len(out["chapters"]) <= 10
    assert out["chapters"][0]["title"] == "Why riders quit"
    assert out["chapters"][1]["title"] != ""            # blank title falls back to the draft
    assert out["text"].splitlines()[0] == "0:00 Why riders quit"


def test_routes_need_a_key_for_claude():
    units = [{"id": u.id, "start": u.start, "end": u.end, "text": u.text} for u in UNITS]
    client = TestClient(app)
    for route in ("/selects", "/chapters"):
        r = client.post(route, json={"units": units, "provider": "claude"})
        assert r.status_code == 400 and "API key" in r.json()["detail"]


def test_selects_job_runs_in_background_and_reports_progress(monkeypatch):
    import time
    from roughcut_engine import app as app_module

    def fake_asker(provider, model, api_key):
        return "fake", fake_ask([cand(0, 9), cand(20, 28, type_="tip")])[0]
    monkeypatch.setattr(app_module, "asker", fake_asker)
    client = TestClient(app)
    units = [{"id": u.id, "start": u.start, "end": u.end, "text": u.text} for u in UNITS]
    job = client.post("/jobs/selects", json={"units": units}).json()["job"]
    for _ in range(50):
        status = client.get(f"/jobs/{job}").json()
        if status["status"] != "running":
            break
        time.sleep(0.05)
    assert status["status"] == "done" and status["result"]["model"] == "fake"
    assert len(status["result"]["clips"]) == 2
    assert client.get("/jobs/nope").status_code == 404


def test_job_reports_errors():
    import time
    from roughcut_engine import jobs

    def boom(progress):
        progress("halfway")
        raise EditError("Ollama isn't running.")
    job = jobs.start(boom)
    for _ in range(50):
        if jobs.get(job)["status"] != "running":
            break
        time.sleep(0.02)
    assert jobs.get(job)["status"] == "error" and "Ollama" in jobs.get(job)["error"]
