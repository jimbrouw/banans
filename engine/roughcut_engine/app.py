"""HTTP API for the RoughCut panel. Binds to 127.0.0.1 only — nothing leaves the machine."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .edit import EditError, Unit, ai_edit, asker
from .selects import run_chapters, run_selects
from . import jobs
from .levels import levels
from .media import MediaError
from .silences import detect_silences
from .transcribe import DEFAULT_MODEL, transcribe

app = FastAPI(title="RoughCut Engine", version=__version__)

# The UXP panel isn't subject to CORS; the Vite browser demo is.
app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?", allow_methods=["*"], allow_headers=["*"])


class SilencesRequest(BaseModel):
    path: str
    noise_db: float = Field(-35.0, le=0)
    min_silence: float = Field(0.5, gt=0)


class LevelsRequest(BaseModel):
    path: str
    channel: int | None = Field(None, ge=0, le=63)  # None = mix all channels
    rate: int = Field(10, ge=1, le=100)


class EditUnit(BaseModel):
    id: int
    start: float
    end: float
    text: str


class EditRequest(BaseModel):
    units: list[EditUnit]
    model: str | None = None
    api_key: str | None = None  # the editor's own key; used for this request only, never stored or logged
    instruction: str | None = Field(None, max_length=2000)
    prefer_last_take: bool = True


class SelectsRequest(BaseModel):
    units: list[EditUnit]
    speakers: dict[int, str] = {}
    model: str | None = None
    api_key: str | None = None  # the editor's own key; used for this request only, never stored or logged
    audio_path: str | None = None  # episode audio, for how lively each passage is
    count: int = Field(5, ge=1, le=10)


class ChaptersRequest(BaseModel):
    units: list[EditUnit]
    model: str | None = None
    api_key: str | None = None


class TranscribeRequest(BaseModel):
    path: str
    model: str | None = None
    language: str | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": __version__, "model": DEFAULT_MODEL}


# Plain `def` handlers run in FastAPI's threadpool, so a long transcription
# doesn't block /health.
@app.post("/silences")
def silences(req: SilencesRequest) -> dict:
    try:
        return detect_silences(req.path, req.noise_db, req.min_silence)
    except MediaError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/levels")
def levels_route(req: LevelsRequest) -> dict:
    try:
        return levels(req.path, req.channel, req.rate)
    except MediaError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/transcribe")
def transcribe_route(req: TranscribeRequest) -> dict:
    try:
        return transcribe(req.path, req.model, req.language)
    except MediaError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/edit")
def edit_route(req: EditRequest) -> dict:
    try:
        units = [Unit(u.id, u.start, u.end, u.text) for u in req.units]
        return ai_edit(units, req.model, req.api_key, req.instruction, req.prefer_last_take)
    except EditError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/selects")
def selects_route(req: SelectsRequest) -> dict:
    try:
        model, ask = asker(req.model, req.api_key)
        units = [Unit(u.id, u.start, u.end, u.text) for u in req.units]
        db = levels(req.audio_path, None, 10)["db"] if req.audio_path else None
        return {"model": model, **run_selects(units, ask, req.speakers, db, 10, req.count)}
    except (EditError, MediaError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/chapters")
def chapters_route(req: ChaptersRequest) -> dict:
    try:
        model, ask = asker(req.model, req.api_key)
        return {"model": model, **run_chapters([Unit(u.id, u.start, u.end, u.text) for u in req.units], ask)}
    except EditError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/jobs/selects")
def start_selects(req: SelectsRequest) -> dict:
    """Start the selects pass in the background (it takes minutes); poll GET /jobs/{id}."""
    try:
        model, ask = asker(req.model, req.api_key)
    except EditError as e:
        raise HTTPException(400, str(e)) from e
    units = [Unit(u.id, u.start, u.end, u.text) for u in req.units]

    def work(progress):
        db = None
        if req.audio_path:
            progress("Measuring how lively each part of the episode is")
            db = levels(req.audio_path, None, 10)["db"]
        return {"model": model, **run_selects(units, ask, req.speakers, db, 10, req.count, progress)}
    return {"job": jobs.start(work)}


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "No such job. The engine may have restarted; start it again.")
    return job
