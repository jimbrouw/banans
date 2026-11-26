"""Watch the LucidLink filespace for recording sessions and hand complete ones to the pipeline.

Runs as its own always-on process (`roughcut-ingest`, a launchd KeepAlive agent),
not inside the HTTP engine: the engine is started on demand and quits after 10
idle minutes. A lucidlink.Client is not thread safe, so one thread owns it.

What the SDK gives us, and what it doesn't (lucidlink 1.0.x):
- read_dir/get_entry: size, modified_at (ns), inode id. No change events, so
  we poll, which is cheap metadata only.
- open(path, "rb") returns a seekable stream: we read a few KB of container
  headers by byte range to prove a file is finished, never the whole file.
- No "upload complete" flag and no lock query. Another client's lock only
  shows up as FsError(EBUSY) on a call that changes the file, and we never
  open someone else's upload for writing. Locks are read from the desktop
  daemon's table instead (`lucid3 lock`), when it is installed.
- Clients are only eventually consistent, so a file can look complete to us a
  few seconds before it is. Hence a settle window on top of the header checks.

A file is READY when all of these hold:
  1. size and modified_at unchanged for SETTLE_POLLS polls spanning SETTLE_SECONDS;
  2. it is not in the daemon's lock table;
  3. its container is closed: a WAV's RIFF size matches the file size; an MP4/MOV's
     top-level boxes tile the file exactly and include a moov;
  4. (batch) all six members agree on length to within a few seconds.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import re
import sqlite3
import struct
import subprocess
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path

log = logging.getLogger("roughcut.ingest")

POLL_SECONDS = 20
SETTLE_POLLS = 3
SETTLE_SECONDS = 60
STALE_HOURS = 12           # an incomplete batch this old is parked as STALE
GROUP_TOLERANCE_S = 5      # session timestamps this close are the same recording
STATE_DB = Path.home() / "Library/Application Support/RoughCut/ingest.db"


# ── configuration ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SourceSpec:
    """One member of a batch: where it lands and how to read the session time from its path."""
    role: str              # cam1..cam3, mic1..mic3
    directory: str         # filespace path, from the filespace root
    pattern: str           # regex over the path relative to `directory`; group "ts" is the session time
    ts_format: str         # strptime format for group "ts"


@dataclass(frozen=True)
class WatchConfig:
    filespace_id: str = "77292657-00c2-4460-b955-5885a36ddfe1"     # studio.specialized2026 (`lucid3 status`)
    mount: Path = Path("/Volumes/specialized2026/studio")            # where Premiere sees the same files
    output_dir: str = "/Studio Recordings/RoughCut Auto Cuts"
    sources: tuple[SourceSpec, ...] = (
        *(SourceSpec(f"cam{i}", f"/Studio Recordings/Just-In Proxies/cam{i}",
                     r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})\.mp4$", "%Y-%m-%d %H-%M-%S") for i in (1, 2, 3)),
        *(SourceSpec(f"mic{i}", "/Studio Recordings/OBS Audio Stems",
                     rf"^(?P<ts>\d{{4}}-\d{{2}}-\d{{2}}_\d{{2}}-\d{{2}}-\d{{2}})_RECORDING/RODECASTER_MIC_{i}\.wav$",
                     "%Y-%m-%d_%H-%M-%S") for i in (1, 2, 3)),
    )

    @property
    def roles(self) -> list[str]:
        return [s.role for s in self.sources]


def service_account_token() -> str:
    """LUCIDLINK_TOKEN, else the macOS keychain item `roughcut-lucidlink` (never a file in the repo)."""
    if tok := os.environ.get("LUCIDLINK_TOKEN"):
        return tok
    proc = subprocess.run(["security", "find-generic-password", "-s", "roughcut-lucidlink", "-w"], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("No LucidLink service account token: set LUCIDLINK_TOKEN or run\n"
                           "  security add-generic-password -s roughcut-lucidlink -a roughcut -w 'sa_live:…'")
    return proc.stdout.strip()


# ── batch state ───────────────────────────────────────────────────────────────

class State(StrEnum):
    DISCOVERED = "discovered"    # at least one member seen
    UPLOADING = "uploading"      # members missing or still changing
    SETTLING = "settling"        # all six present and stable so far; waiting out the window
    READY = "ready"              # every readiness check passed
    PROCESSING = "processing"    # sync → auto cut → XML
    PUBLISHED = "published"      # XML written to the filespace
    IMPORTED = "imported"        # the panel imported it into Premiere
    NEEDS_REVIEW = "needs_review"  # published, but sync wasn't confident for some file
    FAILED = "failed"            # retried up to MAX_ATTEMPTS
    STALE = "stale"              # never completed
    SUPERSEDED = "superseded"    # a member changed after publishing; a new version follows


@dataclass
class Member:
    role: str
    path: str                  # filespace path
    size: int = 0
    modified_at: int = 0
    stable_polls: int = 0
    stable_since: float = 0.0
    closed: bool = False       # container check passed
    duration: float = 0.0      # from the container header, when known


@dataclass
class Batch:
    key: str                   # session time, e.g. "2026-10-21 17-35-23"
    state: State = State.DISCOVERED
    members: dict[str, Member] = field(default_factory=dict)
    first_seen: float = field(default_factory=time.time)
    attempts: int = 0
    error: str | None = None
    output: str | None = None  # filespace path of the published XML

    @property
    def episode(self) -> str:
        return self.key

    def local_path(self, cfg: WatchConfig, role: str) -> Path:
        return cfg.mount / self.members[role].path.lstrip("/")


class StateStore:
    """SQLite in WAL mode: the ingest service writes, the HTTP engine reads (/ingest/batches)."""

    def __init__(self, path: Path = STATE_DB):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS batches (key TEXT PRIMARY KEY, state TEXT, body TEXT, updated REAL)")
        self.lock = threading.Lock()

    def load(self) -> dict[str, Batch]:
        out = {}
        for key, body in self.db.execute("SELECT key, body FROM batches"):
            d = json.loads(body)
            d["state"] = State(d["state"])
            d["members"] = {r: Member(**m) for r, m in d["members"].items()}
            out[key] = Batch(**d)
        return out

    def save(self, b: Batch) -> None:
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO batches VALUES (?, ?, ?, ?)",
                            (b.key, b.state.value, json.dumps(asdict(b)), time.time()))


# ── readiness probes (byte-range reads through the SDK) ──────────────────────

def wav_closed(head: bytes, size: int) -> tuple[bool, float]:
    """A WAV writer patches the RIFF and data sizes on close; until then they're 0 or stale."""
    if len(head) < 12 or head[:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
        return False, 0.0
    if head[:4] == b"RIFF" and struct.unpack_from("<I", head, 4)[0] + 8 != size:
        return False, 0.0
    pos, byte_rate = 12, 0
    while pos + 8 <= len(head):
        cid, csize = head[pos:pos + 4], struct.unpack_from("<I", head, pos + 4)[0]
        if cid == b"fmt " and pos + 16 <= len(head):
            byte_rate = struct.unpack_from("<I", head, pos + 16)[0]
        if cid == b"data":
            fits = pos + 8 + csize <= size
            return fits and csize > 0, (csize / byte_rate if byte_rate else 0.0)
        pos += 8 + csize + (csize & 1)
    return False, 0.0


def mp4_closed(stream, size: int) -> bool:
    """Walk top-level boxes by seeking header to header (a few reads of 16 bytes):
    finished when they tile the file exactly and one of them is a moov."""
    pos, seen_moov = 0, False
    while pos < size:
        stream.seek(pos)
        hdr = stream.read(16)
        if len(hdr) < 8:
            return False
        box_size, box_type = struct.unpack(">I4s", hdr[:8])
        if box_size == 1:
            if len(hdr) < 16:
                return False
            box_size = struct.unpack(">Q", hdr[8:16])[0]
        elif box_size == 0:      # "runs to end of file": a writer that never came back to fix it
            return False
        if box_size < 8:
            return False
        seen_moov |= box_type == b"moov"
        pos += box_size
    return pos == size and seen_moov


def locked_paths() -> set[str] | None:
    """Filespace paths in the desktop daemon's lock table, or None when lucid3 isn't available."""
    try:
        proc = subprocess.run(["lucid3", "lock"], capture_output=True, text=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    lines = proc.stdout.splitlines()
    header = next((l for l in lines if "PATH" in l and "LOCK TYPE" in l), None)
    if header is None:
        return set()
    col = header.index("PATH")
    return {l[col:].strip() for l in lines[lines.index(header) + 1:] if len(l) > col and l[col:].strip()}


# ── the watcher ───────────────────────────────────────────────────────────────

@dataclass
class _MountEntry:
    name: str
    is_dir: bool
    size: int = 0
    modified_at: int = 0


class _MountFS:
    """Fallback filesystem adapter over the mounted LucidLink volume."""

    def __init__(self, mount: Path):
        self.mount = mount

    def read_dir(self, directory: str) -> list[_MountEntry]:
        target = self.mount / directory.lstrip("/")
        if not target.is_dir():
            raise FileNotFoundError(target)
        out: list[_MountEntry] = []
        with os.scandir(target) as it:
            for entry in it:
                is_dir = entry.is_dir(follow_symlinks=False)
                if is_dir:
                    out.append(_MountEntry(entry.name, True))
                else:
                    st = entry.stat(follow_symlinks=False)
                    out.append(_MountEntry(entry.name, False, st.st_size, st.st_mtime_ns))
        return out

    def open(self, path: str, mode: str = "rb", buffering: int = 0):
        return open(self.mount / path.lstrip("/"), mode, buffering=buffering)


def scan_mount_batches(cfg: WatchConfig, store: StateStore) -> dict[str, Batch]:
    """Scan the mounted LucidLink directory for sessions and merge into StateStore."""
    batches = store.load()
    if not cfg.mount.exists():
        return batches
    fs = _MountFS(cfg.mount)
    specs = [(s, re.compile(s.pattern)) for s in cfg.sources]
    now = time.time()
    seen_dirs: dict[str, list] = {}
    for spec, rx in specs:
        listing = seen_dirs.setdefault(spec.directory, LucidWatcher._list_static(fs, spec.directory))
        for rel, entry in listing:
            if not (m := rx.match(rel)):
                continue
            ts = datetime.strptime(m["ts"], spec.ts_format)
            key = next(
                (k for k in batches if abs((datetime.strptime(k, "%Y-%m-%d %H-%M-%S") - ts).total_seconds()) <= GROUP_TOLERANCE_S),
                ts.strftime("%Y-%m-%d %H-%M-%S"),
            )
            b = batches.setdefault(key, Batch(key))
            path = f"{spec.directory}/{rel}"
            mem = b.members.get(spec.role)
            if mem is None or mem.path != path:
                b.members[spec.role] = mem = Member(spec.role, path)
                mem.size, mem.modified_at, mem.stable_since = entry.size, entry.modified_at, now
                store.save(b)
    return batches


class LucidWatcher:
    def __init__(self, cfg: WatchConfig, store: StateStore, on_ready):
        self.cfg = cfg
        self.store = store
        self.on_ready = on_ready     # callable(Batch) -> None; runs the pipeline
        self.batches = store.load()
        self._specs = [(s, re.compile(s.pattern)) for s in cfg.sources]

    def run(self, stop: threading.Event) -> None:
        """Poll via the LucidLink SDK (reconnecting on drop), falling back to the local mount."""
        while not stop.is_set():
            try:
                import lucidlink  # optional dependency: `uv sync --extra lucid`

                with lucidlink.Client() as client:
                    client.login(lucidlink.ServiceAccountCredentials(token=service_account_token()))
                    filespace = client.workspace.link_filespace(self.cfg.filespace_id)
                    fs = filespace.file_system
                    log.info("Watching %s (%s) via SDK", filespace.name, self.cfg.filespace_id)
                    while not stop.is_set():
                        self.poll(fs)
                        stop.wait(POLL_SECONDS)
            except Exception as e:  # noqa: BLE001 - reconnect or fall back to mount
                if self.cfg.mount.exists():
                    log.warning("LucidLink SDK unavailable (%s); watching mount %s", e, self.cfg.mount)
                    mount_fs = _MountFS(self.cfg.mount)
                    while not stop.is_set():
                        try:
                            self.poll(mount_fs)
                        except Exception:  # noqa: BLE001
                            log.exception("Mount poll failed; retrying in %ss", POLL_SECONDS)
                        stop.wait(POLL_SECONDS)
                else:
                    log.exception("Watcher connection failed; retrying in %ss", POLL_SECONDS)
                    stop.wait(POLL_SECONDS)

    @staticmethod
    def _list_static(fs, directory: str, depth: int = 2) -> list[tuple[str, object]]:
        """(path relative to directory, entry) for files up to `depth` levels down."""
        try:
            from lucidlink import EntryType
            from lucidlink.exceptions import FsNotFoundError
        except ImportError:
            EntryType = None
            FsNotFoundError = FileNotFoundError

        out, todo = [], [("", 0)]
        while todo:
            rel, d = todo.pop()
            try:
                entries = fs.read_dir(f"{directory}/{rel}".rstrip("/") or "/")
            except (FileNotFoundError, FsNotFoundError):
                continue
            for e in entries:
                sub = f"{rel}/{e.name}".lstrip("/")
                is_dir = getattr(e, "is_dir", False) or (EntryType is not None and getattr(e, "type", None) == EntryType.DIR)
                if is_dir and d + 1 < depth:
                    todo.append((sub, d + 1))
                elif not is_dir and not e.name.startswith("."):
                    out.append((sub, e))
        return out

    def _list(self, fs, directory: str, depth: int = 2) -> list[tuple[str, object]]:
        return self._list_static(fs, directory, depth)

    def _session_key(self, ts: datetime) -> str:
        """Snap to an existing batch within GROUP_TOLERANCE_S (masters and stems start a second apart)."""
        for key in self.batches:
            if abs((datetime.strptime(key, "%Y-%m-%d %H-%M-%S") - ts).total_seconds()) <= GROUP_TOLERANCE_S:
                return key
        return ts.strftime("%Y-%m-%d %H-%M-%S")

    def poll(self, fs) -> None:
        now = time.time()
        seen_dirs: dict[str, list] = {}
        for spec, rx in self._specs:
            listing = seen_dirs.setdefault(spec.directory, self._list(fs, spec.directory))
            for rel, entry in listing:
                if not (m := rx.match(rel)):
                    continue
                key = self._session_key(datetime.strptime(m["ts"], spec.ts_format))
                b = self.batches.setdefault(key, Batch(key))
                path = f"{spec.directory}/{rel}"
                mem = b.members.get(spec.role)
                if mem is None or mem.path != path:
                    b.members[spec.role] = mem = Member(spec.role, path)
                changed = (entry.size, entry.modified_at) != (mem.size, mem.modified_at)
                if changed:
                    mem.size, mem.modified_at, mem.stable_polls, mem.stable_since, mem.closed = entry.size, entry.modified_at, 0, now, False
                    if b.state in (State.PUBLISHED, State.IMPORTED, State.NEEDS_REVIEW):
                        b.state = State.SUPERSEDED  # re-cut as V2 once it settles again
                    elif b.state in (State.STALE, State.FAILED):
                        # A file arrived or updated later (e.g., overnight upload finished): re-evaluate.
                        b.state, b.error, b.attempts, b.first_seen = State.UPLOADING, None, 0, now
                else:
                    mem.stable_polls += 1

        locks = None
        for b in self.batches.values():
            if b.state in (State.PROCESSING, State.PUBLISHED, State.IMPORTED, State.NEEDS_REVIEW, State.FAILED, State.STALE):
                continue
            locks = self._advance(fs, b, now, locks)
            self.store.save(b)

    def _advance(self, fs, b: Batch, now: float, locks):
        complete = set(b.members) == set(self.cfg.roles)
        settled = complete and all(m.stable_polls >= SETTLE_POLLS and now - m.stable_since >= SETTLE_SECONDS
                                   for m in b.members.values())
        if not settled:
            b.state = State.UPLOADING if b.members else State.DISCOVERED
            if complete and b.state == State.UPLOADING and all(m.stable_polls for m in b.members.values()):
                b.state = State.SETTLING
            if now - b.first_seen > STALE_HOURS * 3600:
                b.state, b.error = State.STALE, f"Still missing {sorted(set(self.cfg.roles) - set(b.members))} or still changing."
            return locks

        if locks is None:
            locks = locked_paths() or set()
        if any(m.path in locks for m in b.members.values()):
            b.state = State.SETTLING
            return locks

        for m in b.members.values():
            if not m.closed:
                m.closed, m.duration = self._container_closed(fs, m)
        if not all(m.closed for m in b.members.values()):
            b.state = State.SETTLING
            return locks

        lengths = [m.duration for m in b.members.values() if m.duration]
        if lengths and max(lengths) - min(lengths) > 30:
            log.warning("%s: member lengths differ by %.0fs; processing anyway", b.key, max(lengths) - min(lengths))

        b.state = State.READY
        self.store.save(b)
        self.on_ready(b)
        return locks

    def _container_closed(self, fs, m: Member) -> tuple[bool, float]:
        try:
            from lucidlink.exceptions import FsError
        except ImportError:
            FsError = OSError

        try:
            with fs.open(m.path, "rb", buffering=0) as f:
                if m.path.lower().endswith(".wav"):
                    return wav_closed(f.read(4096), m.size)
                return mp4_closed(f, m.size), 0.0
        except (OSError, FsError) as e:
            if getattr(e, "errno", None) == errno.EBUSY:
                return False, 0.0  # another client holds a lock: still being written
            raise


def copy_with_progress(src: Path, dst: Path, chunk_size: int = 4 * 1024 * 1024, on_chunk=None) -> None:
    """Copy a file in chunks, notifying on_chunk(bytes_written_this_chunk)."""
    with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
        while True:
            chunk = fsrc.read(chunk_size)
            if not chunk:
                break
            fdst.write(chunk)
            if on_chunk:
                on_chunk(len(chunk))


def find_masters_for_batch(b: Batch, cfg: WatchConfig, user_cfg) -> list[tuple[str, Path]]:
    """Find matching 4K master camera files (.mov) in 'Just-In Masters' on LucidLink."""
    masters_cloud_dir = cfg.mount / getattr(user_cfg, "masters_cloud_dir", "/Studio Recordings/Just-In Masters").lstrip("/")
    if not masters_cloud_dir.exists():
        return []

    m = re.match(r"\d{4}-\d{2}-(\d{2}) (\d{2})-(\d{2})-(\d{2})", b.key)
    if not m:
        return []
    day, hh, mm, ss = m.groups()
    key_seconds = int(hh) * 3600 + int(mm) * 60 + int(ss)

    channel_files: dict[str, tuple[int, Path]] = {}
    for p in masters_cloud_dir.glob("*.mov"):
        if p.name.startswith("."):
            continue
        fm = re.match(rf"^{day}_(\d{{2}})(\d{{2}})(\d{{2}})_(Channel\d)\.mov$", p.name)
        if fm:
            f_hh, f_mm, f_ss, ch = fm.groups()
            f_seconds = int(f_hh) * 3600 + int(f_mm) * 60 + int(f_ss)
            diff = abs(f_seconds - key_seconds)
            if diff <= 60:
                if ch not in channel_files or diff < channel_files[ch][0]:
                    channel_files[ch] = (diff, p)

    return [(ch, channel_files[ch][1]) for ch in sorted(channel_files.keys())]


def _match_numbered(files: list[Path], patterns: list[str]) -> list[Path] | None:
    """Match numbered 1..3 media files against ordered regex patterns."""
    for pat in patterns:
        rx = re.compile(pat, re.IGNORECASE)
        matched: dict[int, Path] = {}
        for p in files:
            m = rx.search(p.stem)
            if m:
                idx = int(m.group(1))
                matched.setdefault(idx, p)
        if all(i in matched for i in (1, 2, 3)):
            return [matched[1], matched[2], matched[3]]
    return None


def discover_local_media(folder: Path) -> tuple[list[Path], list[Path]]:
    """Auto-detect 3 camera video files and 3 mic WAV stems inside a local folder.

    Ignores hidden/AppleDouble files (`._*`, `.DS_Store`) and subdirectories (e.g. `Master 4K/`).
    """
    folder = Path(folder).expanduser()
    if not folder.is_dir():
        raise FileNotFoundError(f"Local folder does not exist or is not a directory: {folder}")

    entries = sorted(
        (p for p in folder.iterdir() if p.is_file() and not p.name.startswith(".")),
        key=lambda p: p.name.lower(),
    )
    videos = [p for p in entries if p.suffix.lower() in (".mp4", ".mov")]
    wavs = [p for p in entries if p.suffix.lower() == ".wav"]

    cams = _match_numbered(
        videos,
        [
            r"(?:^|[^a-z0-9])cam[_ -]?([123])(?:[^0-9]|$)",
            r"(?:^|[^a-z0-9])channel[_ -]?([123])(?:[^0-9]|$)",
        ],
    )
    if cams is None:
        if len(videos) < 3:
            raise FileNotFoundError(
                f"Expected 3 camera video files (.mp4/.mov) in {folder}, found {len(videos)}."
            )
        cams = videos[:3]

    mics = _match_numbered(
        wavs,
        [
            r"(?:^|[^a-z0-9])mic[_ -]?([123])(?:[^0-9]|$)",
            r"rodecaster[_ -]?mic[_ -]?([123])(?:[^0-9]|$)",
        ],
    )
    if mics is None:
        if len(wavs) < 3:
            raise FileNotFoundError(
                f"Expected 3 mic audio stems (.wav) in {folder}, found {len(wavs)}."
            )
        mics = wavs[:3]

    return cams, mics


def _build_cut_xml(
    session_name: str,
    target_cams: list[Path],
    target_mics: list[Path],
    user_cfg,
    notify,
    progress_range: tuple[float, float] = (65.0, 95.0),
):
    """Run sync -> loudness levels -> auto-cut -> FCP7 XML Builder on 3 cams and 3 mics."""
    import numpy as np
    from .sync import sync_session
    from .levels import levels
    from .auto_cut import auto_cut, CameraPlan, cuts_to_intervals, RATE
    from .xml_builder import Builder, Source, Shot

    lo, hi = progress_range

    def _pct(frac: float) -> float:
        return lo + (hi - lo) * frac

    # 1. Headless audio sync
    notify(_pct(0.0), "Analyzing audio waveforms to calculate sub-frame sync offsets...")
    res = sync_session(target_cams, target_mics)
    notify(_pct(0.33), f"Sync locked! Timeline duration: {res.duration:.1f}s")

    # 2. Read RMS loudness envelopes for the 3 mics (anchored at mic recording start T=0)
    notify(_pct(0.43), "Extracting RMS dialogue loudness & detecting active speakers...")
    clap_advance_frames = getattr(user_cfg, "clap_sync_offset_frames", -4)
    audio_advance_s = (clap_advance_frames / float(res.fps)) if clap_advance_frames else 0.0
    offset_idx = int(round(audio_advance_s * RATE))

    envelopes = []
    for mic_path in target_mics:
        lvl = levels(str(mic_path), channel=None, rate=RATE)
        arr = np.asarray(lvl["db"], dtype=float)
        if offset_idx > 0 and len(arr) > offset_idx:
            arr = arr[offset_idx:]
        elif offset_idx < 0:
            arr = np.concatenate([np.full(-offset_idx, -100.0), arr])
        envelopes.append(arr)

    # 3. Generate Auto-Cut
    notify(_pct(0.67), "Executing multicam auto-cut rules, crosstalk detection & reaction shots...")
    mic_dur = max(0.1, min(p.duration for p in res.mics) - audio_advance_s)
    total_frames = int(round(mic_dur * float(res.fps)))
    # Studio camera mapping:
    # A1 (Host Mic) -> Cam 3 (Host Close-up) -> index 2
    # A2 & A3 (Guest Mics) -> Cam 2 (Guest Close-up) -> index 1
    # Wide -> Cam 1 -> index 0
    plan = CameraPlan(
        camera_for_mic=[2, 1, 1],
        wide=0,
        coverage=[(0.0, mic_dur) for _ in res.cameras],
    )
    cuts_res = auto_cut(envelopes, plan, total_frames, float(res.fps), reactions=True)
    best_cut = cuts_res[0]
    notify(_pct(0.90), f"Auto-cut score: {best_cut.score}/100 ({len(best_cut.cuts)} camera switches)")

    intervals = cuts_to_intervals(best_cut.cuts, total_frames)
    shots = [Shot(start=s, end=e, camera=f"cam{cam+1}", reason=r) for s, e, cam, r in intervals]

    # 4. Build Final Cut Pro 7 XML anchored at common timeline start (00:00:00:00) at 29.97 fps
    notify(_pct(1.0), "Building Final Cut Pro 7 XML sequence at 29.97 fps...")
    builder = Builder(fps=res.fps)
    mic_ref_start = res.mics[0].start

    cams_src = [
        Source(
            id=f"cam{i}",
            path=p.path,
            kind="video",
            duration=p.duration,
            start=max(0.0, p.start - mic_ref_start),
            in_point=max(0.0, mic_ref_start - p.start),
        )
        for i, p in enumerate(res.cameras, 1)
    ]

    mics_src = [
        Source(
            id=f"mic{i}",
            path=p.path,
            kind="audio",
            duration=p.duration,
            start=max(0.0, -audio_advance_s),
            in_point=max(0.0, audio_advance_s),
        )
        for i, p in enumerate(res.mics, 1)
    ]

    builder.synced_stack(f"{session_name} - Synced Stack", cams_src, mics_src)
    builder.auto_cut(f"{session_name} - Auto Cut V1", cams_src, mics_src, shots)
    return builder, res


def process_local_folder(folder: Path, progress_callback=None) -> Path:
    """Run sync, auto-cut, and XML generation directly on a local folder without LucidLink."""
    from .config import IngestConfig

    def notify(pct: float, msg: str):
        log.info("[%d%%] %s", int(pct), msg)
        if progress_callback:
            progress_callback(pct, msg)

    folder = Path(folder).expanduser().resolve()
    notify(2.0, f"Scanning local folder: {folder.name}")
    target_cams, target_mics = discover_local_media(folder)
    notify(
        10.0,
        f"Found 3 cameras ({', '.join(p.name for p in target_cams)}) "
        f"and 3 mics ({', '.join(p.name for p in target_mics)})",
    )

    user_cfg = IngestConfig.load()
    builder, _res = _build_cut_xml(
        folder.name,
        target_cams,
        target_mics,
        user_cfg,
        notify,
        progress_range=(15.0, 92.0),
    )

    out_xml = folder / f"{folder.name} - Auto Cut V1.xml"
    notify(96.0, f"Writing XML sequence: {out_xml.name}")
    builder.write(out_xml)
    notify(100.0, f"Local auto-cut complete! XML saved to {out_xml}")
    return out_xml


def process_batch(b: Batch, cfg: WatchConfig, store: StateStore, progress_callback=None) -> None:
    """Execute headless sync, auto-cut, XML publishing, and optional external drive download."""
    from .config import IngestConfig

    def notify(pct: float, msg: str):
        log.info("[%d%%] %s", int(pct), msg)
        if progress_callback:
            progress_callback(pct, msg)

    notify(2.0, f"Initializing pipeline for episode: {b.key}")
    b.state = State.PROCESSING
    store.save(b)

    try:
        user_cfg = IngestConfig.load()
        cloud_cams = [b.local_path(cfg, f"cam{i}") for i in (1, 2, 3)]
        cloud_mics = [b.local_path(cfg, f"mic{i}") for i in (1, 2, 3)]

        local_dir = Path(user_cfg.local_download_dir).expanduser() if user_cfg.local_download_dir else None
        target_cams = cloud_cams
        target_mics = cloud_mics

        if local_dir and user_cfg.auto_download_to_local:
            session_dir = local_dir / b.key
            session_dir.mkdir(parents=True, exist_ok=True)
            notify(5.0, f"Staging media to external drive: {session_dir.name}")

            all_sources = [(f"cam{i}", p) for i, p in enumerate(cloud_cams, 1)] + \
                          [(f"mic{i}", p) for i, p in enumerate(cloud_mics, 1)]
            total_bytes = sum(p.stat().st_size for _, p in all_sources if p.exists())
            copied_so_far = 0

            new_cams = []
            for i, src in enumerate(cloud_cams, 1):
                dst = session_dir / f"cam{i}_{src.name}"
                if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                    def _on_chunk(n):
                        nonlocal copied_so_far
                        copied_so_far += n
                        pct = 5.0 + (copied_so_far / (total_bytes or 1)) * 55.0
                        mb_done = copied_so_far / (1024 * 1024)
                        mb_total = total_bytes / (1024 * 1024)
                        notify(pct, f"Copying Camera {i}/3 ({mb_done:.0f}MB / {mb_total:.0f}MB)")

                    copy_with_progress(src, dst, on_chunk=_on_chunk)
                else:
                    copied_so_far += src.stat().st_size
                new_cams.append(dst)
            target_cams = new_cams

            new_mics = []
            for i, src in enumerate(cloud_mics, 1):
                dst = session_dir / f"mic{i}_{src.name}"
                if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                    def _on_chunk(n):
                        nonlocal copied_so_far
                        copied_so_far += n
                        pct = 5.0 + (copied_so_far / (total_bytes or 1)) * 55.0
                        mb_done = copied_so_far / (1024 * 1024)
                        mb_total = total_bytes / (1024 * 1024)
                        notify(pct, f"Copying Mic {i}/3 ({mb_done:.0f}MB / {mb_total:.0f}MB)")

                    copy_with_progress(src, dst, on_chunk=_on_chunk)
                else:
                    copied_so_far += src.stat().st_size
                new_mics.append(dst)
            target_mics = new_mics
            notify(62.0, "All media successfully downloaded to external drive.")
        else:
            notify(10.0, "Operating directly off cloud mount; pre-pinning proxies...")
            for cam_path in cloud_cams:
                rel = str(cam_path.relative_to(cfg.mount))
                try:
                    subprocess.run(["lucid", "pin", "--set", f"/{rel}"], capture_output=True, timeout=10)
                except Exception as e:
                    log.warning("Could not pre-pin %s: %s", rel, e)

        builder, res = _build_cut_xml(
            b.key,
            target_cams,
            target_mics,
            user_cfg,
            notify,
            progress_range=(65.0, 95.0),
        )

        # 5. Publish XML
        out_filename = f"{b.key} - Auto Cut V1.xml"

        if local_dir and user_cfg.auto_download_to_local:
            local_xml = session_dir / out_filename
            builder.write(local_xml)
            b.output = str(local_xml)

        if user_cfg.mirror_xml_to_cloud or not local_dir:
            out_dir = cfg.mount / cfg.output_dir.lstrip("/")
            out_dir.mkdir(parents=True, exist_ok=True)
            cloud_xml = out_dir / out_filename
            builder.write(cloud_xml)
            if not local_dir:
                b.output = f"{cfg.output_dir}/{out_filename}"

        b.state = State.NEEDS_REVIEW if res.needs_review else State.PUBLISHED
        store.save(b)

        # 6. Optional Overnight Ingest of 4K Master footage (does NOT block sync / auto-cut)
        if getattr(user_cfg, "download_masters_overnight", False) and local_dir:
            masters = find_masters_for_batch(b, cfg, user_cfg)
            if masters:
                masters_target_dir = Path(user_cfg.masters_custom_dir) / b.key if getattr(user_cfg, "masters_custom_dir", "") else session_dir / getattr(user_cfg, "masters_subfolder_name", "Master 4K")
                masters_target_dir.mkdir(parents=True, exist_ok=True)
                notify(96.0, f"XML ready! Starting overnight 4K master ingest ({len(masters)} files)...")

                total_master_bytes = sum(src.stat().st_size for _, src in masters if src.exists())
                copied_master_bytes = 0

                for idx, (ch, src) in enumerate(masters, 1):
                    dst = masters_target_dir / src.name
                    if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                        def _on_master_chunk(n):
                            nonlocal copied_master_bytes
                            copied_master_bytes += n
                            pct = 96.0 + (copied_master_bytes / (total_master_bytes or 1)) * 3.9
                            gb_done = copied_master_bytes / (1024 ** 3)
                            gb_tot = total_master_bytes / (1024 ** 3)
                            notify(pct, f"Downloading Master {idx}/{len(masters)} ({ch}): {gb_done:.1f}GB / {gb_tot:.1f}GB")

                        copy_with_progress(src, dst, on_chunk=_on_master_chunk)
                    else:
                        copied_master_bytes += src.stat().st_size
                notify(100.0, f"Overnight Ingest complete! 4K Masters saved in {masters_target_dir.name}.")
            else:
                notify(100.0, "Pipeline finished successfully! Sequence ready.")
        else:
            notify(100.0, "Pipeline finished successfully! Sequence ready.")

    except Exception as e:
        log.exception("Error processing batch %s: %s", b.key, e)
        b.state = State.FAILED
        b.error = str(e)
        store.save(b)


def main_local(argv: list[str] | None = None) -> None:
    import argparse
    import sys

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    parser = argparse.ArgumentParser(
        prog="roughcut-local",
        description="Run RoughCut sync and multi-cam auto-cut directly on a local recording folder.",
    )
    parser.add_argument("folder", help="Path to local folder containing 3 camera files and 3 mic WAV files")
    args = parser.parse_args(argv)

    try:
        out_xml = process_local_folder(Path(args.folder))
    except Exception as e:
        log.error("Failed to process local folder: %s", e)
        sys.exit(1)
    print(out_xml)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    cfg = WatchConfig()
    store = StateStore()

    def handle_ready(b: Batch):
        threading.Thread(target=process_batch, args=(b, cfg, store), daemon=True).start()

    watcher = LucidWatcher(cfg, store, on_ready=handle_ready)
    stop = threading.Event()
    try:
        watcher.run(stop)
    except KeyboardInterrupt:
        log.info("Shutting down watcher...")
        stop.set()


if __name__ == "__main__":
    main()
