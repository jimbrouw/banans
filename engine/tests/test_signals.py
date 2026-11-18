from roughcut_engine.edit import Unit
from roughcut_engine.selects import CANDIDATE_SYSTEM, JUDGE_SYSTEM, run_selects
from roughcut_engine.signals import MIN_SCORE, hint_block, hot_lines, loud_lines

# Ten plain lines, 3 s each with a 0.3 s breath, so by default nothing scores.
UNITS = [Unit(i, round(i * 3.3, 2), round(i * 3.3 + 3, 2), f"This is a calm and ordinary sentence number {i}.") for i in range(10)]


def with_text(i, text, **kw):
    units = list(UNITS)
    u = units[i]
    units[i] = Unit(i, kw.get("start", u.start), kw.get("end", u.end), text)
    return units


def reasons(units, speakers=None, db=None):
    return {u.id: why for _, u, why in hot_lines(units, speakers or {}, db)}


def test_plain_speech_scores_nothing():
    assert hot_lines(UNITS, {}) == []
    assert hint_block(UNITS, {}) == ""


def test_a_single_weak_signal_is_not_enough():
    # Short and punchy alone is worth 0.5, under the bar.
    assert 0.5 < MIN_SCORE
    assert reasons(with_text(3, "Just one thing.")) == {}


def test_question_trigger_and_emphasis_add_up():
    got = reasons(with_text(4, "Why did nobody ever warn me about that?"))
    assert got[4] == ["question", "trigger word", "short and punchy"]   # exactly 8 words
    assert 5 not in got


def test_pause_before_and_quick_exchange():
    units = with_text(6, "Okay, go on then.", start=22.0, end=24.5)   # 2.3 s after line 5 ends
    speakers = {5: "Host", 6: "Guest"}
    assert reasons(units, speakers)[6] == ["pause before", "quick exchange", "short and punchy"]
    # Without speaker labels the quick-exchange term is skipped; pause + punchy is exactly the bar and still counts.
    assert reasons(units, {})[6] == ["pause before", "short and punchy"]


def test_loud_lines_need_a_sustained_peak_over_the_episode_level():
    rate = 10
    db = [-30.0] * 330
    db[int(UNITS[2].start * rate) + 1] = -10.0                                      # a single spike: a clap, not a voice
    assert loud_lines(UNITS, db, rate) == set()
    for k in range(3):
        db[int(UNITS[3].start * rate) + k] = -15.0                                  # three loud frames
    assert loud_lines(UNITS, db, rate) == {3}


def test_loudness_is_skipped_without_audio_and_never_crashes_on_silence():
    assert loud_lines(UNITS, [], 10) == set()
    assert loud_lines(UNITS, [-100.0] * 100, 10) == set()
    assert hot_lines(with_text(1, "Seriously? That is wild!"), {})[0][1].id == 1


def test_top_is_capped_and_best_first():
    units = [Unit(i, i * 3.3, i * 3.3 + 3, "Why is this so insane?") for i in range(30)]
    got = hot_lines(units, {})
    assert len(got) == 12 and [s for s, _, _ in got] == sorted((s for s, _, _ in got), reverse=True)


def test_hint_block_lists_lines_in_episode_order_with_the_reasons():
    block = hint_block(with_text(7, "Wait, what is the secret?"), {})
    assert "hints only" in block.lower() and "[7]" in block and "question" in block


def test_hints_reach_the_candidate_prompt_and_never_remove_candidates():
    units = [Unit(i, round(i * 3.3, 2), round(i * 3.3 + 3, 2), f"Line {i} about topic {i // 10}.") for i in range(60)]
    units[5] = Unit(5, 16.5, 19.5, "Why did nobody ever tell me that?")
    seen = []

    def ask(system, user, schema):
        if system == CANDIDATE_SYSTEM:
            seen.append(user)
            return {"candidates": [
                {"first": 30, "last": 38, "hook_line": -1, "type": "tip", "idea": "a quiet one", "title": "Working title 12", "why": "x"}]}
        assert system == JUDGE_SYSTEM
        return {"winner": "A", "reason": "r"}

    out = run_selects(units, ask)
    assert "[5]" in seen[0] and "Hints from the audio" in seen[0]
    assert [c["lines"] for c in out["clips"]] == [[30, 38]]   # a clip in a stretch with no hints still comes through
