from fastapi import FastAPI
from fastapi.testclient import TestClient

from roughcut_engine.__main__ import IdleWatch, add_idle_tracking, launchd_socket


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def test_idle_counts_from_the_last_request_and_never_while_busy():
    clock = Clock()
    watch = IdleWatch(clock)
    clock.t = 160
    assert watch.idle_for() == 60
    watch.started()
    clock.t = 900
    assert watch.idle_for() == 0  # a long transcription is not idle time
    watch.finished()
    clock.t = 930
    assert watch.idle_for() == 30


def test_middleware_tracks_requests():
    clock = Clock()
    watch = IdleWatch(clock)
    app = FastAPI()

    @app.get("/ping")
    def ping():
        assert watch.active == 1
        return {"ok": True}

    add_idle_tracking(app, watch)
    clock.t = 500
    assert TestClient(app).get("/ping").json() == {"ok": True}
    assert watch.active == 0 and watch.last == 500


def test_no_launchd_socket_when_started_by_hand():
    assert launchd_socket() is None
