"""Background jobs for passes that take minutes (the selects pass on a local model).

A long request would outlive the caller's HTTP timeout (Node's fetch gives up
after 5 minutes) and lose the answer. Instead the caller starts a job, gets an
id straight away, and polls it. Polling also keeps an on-demand engine awake.
"""

import threading
import time
import uuid
from typing import Callable

from .edit import EditError
from .media import MediaError

KEEP_SECONDS = 3600  # finished jobs are forgotten after an hour

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def start(work: Callable[[Callable[[str], None]], dict]) -> str:
    """Run work(progress) on a thread; returns the job id."""
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "status": "running", "step": "Starting", "result": None, "error": None, "started": time.time()}
    with _lock:
        now = time.time()
        for old in [k for k, j in _jobs.items() if j["status"] != "running" and now - j["started"] > KEEP_SECONDS]:
            del _jobs[old]
        _jobs[job_id] = job

    def progress(step: str) -> None:
        job["step"] = step

    def run() -> None:
        try:
            job.update(result=work(progress), status="done", step="Done")
        except (EditError, MediaError) as e:
            job.update(status="error", error=str(e))
        except Exception as e:  # noqa: BLE001 - report anything to the caller rather than dying silently
            job.update(status="error", error=f"Unexpected error: {e}")

    threading.Thread(target=run, daemon=True).start()
    return job_id


def get(job_id: str) -> dict | None:
    job = _jobs.get(job_id)
    if not job:
        return None
    return {**job, "seconds": round(time.time() - job["started"])}
