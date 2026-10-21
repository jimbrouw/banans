"""Start the engine.

Two ways it runs:
- On demand (installed with engine/install.sh): macOS holds 127.0.0.1:7317 and
  starts the engine when the panel first connects; the engine quits after
  RC_ENGINE_IDLE seconds without requests. Nothing runs while you're not
  using Premiere.
- By hand (`uv run roughcut-engine`): binds the port itself and stays up.
"""

import ctypes
import os
import socket
import threading
import time

import uvicorn

PORT = int(os.environ.get("RC_ENGINE_PORT", "7317"))
IDLE_SECONDS = float(os.environ.get("RC_ENGINE_IDLE", "600"))
LAUNCHD_SOCKET = b"Listener"  # must match the Sockets key in install.sh's plist


def launchd_socket() -> socket.socket | None:
    """The listening socket launchd passed us, or None when started by hand."""
    try:
        libc = ctypes.CDLL(None)
        fds = ctypes.POINTER(ctypes.c_int)()
        count = ctypes.c_size_t(0)
        if libc.launch_activate_socket(LAUNCHD_SOCKET, ctypes.byref(fds), ctypes.byref(count)) != 0 or count.value == 0:
            return None
        return socket.socket(fileno=fds[0])
    except (AttributeError, OSError):
        return None


class IdleWatch:
    """Tracks in-flight requests and the time of the last one."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.last = clock()
        self.active = 0
        self.lock = threading.Lock()

    def started(self):
        with self.lock:
            self.active += 1
            self.last = self.clock()

    def finished(self):
        with self.lock:
            self.active -= 1
            self.last = self.clock()

    def idle_for(self) -> float:
        with self.lock:
            return 0.0 if self.active else self.clock() - self.last


def add_idle_tracking(app, watch: IdleWatch):
    @app.middleware("http")
    async def track(request, call_next):
        watch.started()
        try:
            return await call_next(request)
        finally:
            watch.finished()


def main() -> None:
    from .app import app

    sock = launchd_socket()
    if sock is None:
        uvicorn.run(app, host="127.0.0.1", port=PORT)
        return

    watch = IdleWatch()
    add_idle_tracking(app, watch)
    server = uvicorn.Server(uvicorn.Config(app, log_level="info"))

    def stop_when_idle():
        while not server.should_exit:
            time.sleep(15)
            if watch.idle_for() >= IDLE_SECONDS:
                print(f"Idle for {IDLE_SECONDS:.0f}s, exiting; launchd restarts on the next connection.", flush=True)
                server.should_exit = True

    threading.Thread(target=stop_when_idle, daemon=True).start()
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
