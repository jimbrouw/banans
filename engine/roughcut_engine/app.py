"""HTTP API for the RoughCut panel. Binds to 127.0.0.1 only — nothing leaves the machine."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
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


@app.post("/transcribe")
def transcribe_route(req: TranscribeRequest) -> dict:
    try:
        return transcribe(req.path, req.model, req.language)
    except MediaError as e:
        raise HTTPException(400, str(e)) from e
