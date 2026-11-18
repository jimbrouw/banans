"""Word-level transcription with mlx-whisper (Whisper on Apple Silicon / Metal).

Whisper normally "cleans up" speech and drops um/uh. A disfluent initial
prompt nudges it to keep them, which is what filler removal needs.
"""

import os
import re
import threading

from .media import cache_get, cache_key, cache_put, extract_wav, require_file

DEFAULT_MODEL = os.environ.get("RC_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")

VERBATIM_PROMPT = "Umm, so, uh, I was like, hmm... I mean, er, you know, it's, uh, kind of hard to say."

# Hard fillers only. "like" / "you know" / "so" depend on context — that's the AI pass's job.
FILLERS = {"um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm"}

_lock = threading.Lock()  # one model in memory, one transcription at a time


def normalise(word: str) -> str:
    return re.sub(r"[^\w']", "", word.lower())


def flatten(result: dict) -> dict:
    """mlx-whisper output → {language, segments:[{start,end,text}], words:[{text,start,end,prob,filler,segment}]}."""
    segments, words = [], []
    for i, seg in enumerate(result.get("segments", [])):
        segments.append({"start": round(seg["start"], 3), "end": round(seg["end"], 3), "text": seg["text"].strip()})
        for w in seg.get("words", []):
            text = w["word"].strip()
            if not text:
                continue
            words.append({
                "text": text,
                "start": round(w["start"], 3),
                "end": round(w["end"], 3),
                "prob": round(w.get("probability", 0.0), 3),
                "filler": normalise(text) in FILLERS,
                "segment": i,
            })
    return {"language": result.get("language"), "segments": segments, "words": words}


def transcribe(path: str, model: str | None = None, language: str | None = None) -> dict:
    p = require_file(path)
    model = model or DEFAULT_MODEL
    params = {"model": model, "language": language, "prompt": VERBATIM_PROMPT}
    key = cache_key(p, "transcribe", params)
    if cached := cache_get(key):
        return cached

    import mlx_whisper  # heavy import; keep /health and /silences fast to start

    wav = extract_wav(p, cache_key(p, "wav", {}))
    with _lock:
        raw = mlx_whisper.transcribe(
            str(wav),
            path_or_hf_repo=model,
            word_timestamps=True,
            initial_prompt=VERBATIM_PROMPT,
            language=language,
            condition_on_previous_text=False,  # stops one hallucination repeating across the file
        )
    result = {"model": model, **flatten(raw)}
    cache_put(key, result)
    return result
