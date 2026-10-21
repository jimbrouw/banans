"""HTTP API for the RoughCut panel. Binds to 127.0.0.1 only — nothing leaves the machine."""

from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .edit import EditError, Unit, ai_edit
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
    provider: Literal["ollama", "claude"] = "ollama"
    model: str | None = None
    api_key: str | None = None  # the editor's own key; used for this request only, never stored or logged
    instruction: str | None = Field(None, max_length=2000)
    prefer_last_take: bool = True


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
        return ai_edit(units, req.provider, req.model, req.api_key, req.instruction, req.prefer_last_take)
    except EditError as e:
        raise HTTPException(400, str(e)) from e
