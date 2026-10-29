"""Final Cut Pro 7 XML (xmeml v4) for Premiere: the synced stack and the bladed auto cut.

Premiere turns each <sequence> into a sequence on File > Import, or from the
panel with project.importFiles. What it relies on, learned from its own exports
(see src/xmlCut.ts):
- the first use of a <file id> carries the full definition; later uses are bare;
- every time is an integer frame count at the sequence timebase; 29.97 fps is
  timebase 30 with ntsc TRUE;
- pathurl is file://localhost plus the percent-encoded absolute path.

Both sequences go in one file so Premiere imports the shared media once.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from urllib.parse import quote


@dataclass
class Source:
    id: str                    # "cam1", "mic2": also the clip name prefix
    path: Path                 # on the local LucidLink mount, as Premiere will open it
    kind: str                  # "video" (camera, with scratch audio) or "audio" (mic stem)
    duration: float            # seconds
    start: float               # seconds on the session timeline (from sync)
    in_point: float = 0.0      # trim offset inside source file
    width: int = 1920
    height: int = 1080
    audio_rate: int = 48000
    audio_channels: int = 2


@dataclass
class Shot:
    start: int     # sequence frames, inclusive
    end: int       # sequence frames, exclusive
    camera: str    # Source.id of the camera on screen
    reason: str = ""


@dataclass
class Marker:
    frame: int
    name: str
    comment: str = ""


def timebase(fps: Fraction) -> tuple[int, bool]:
    """(timebase, ntsc): 30000/1001 → (30, True), 25 → (25, False)."""
    tb = round(float(fps))
    return tb, abs(float(fps) - tb) > 1e-3


def pathurl(path: Path) -> str:
    return "file://localhost" + quote(str(path), safe="/")


def _sub(parent: ET.Element, tag: str, text: object | None = None, **attrs: str) -> ET.Element:
    el = ET.SubElement(parent, tag, attrs)
    if text is not None:
        el.text = str(text).upper() if isinstance(text, bool) else str(text)
    return el


class Builder:
    """Accumulates sequences; tracks which file ids are already defined in the document."""

    def __init__(self, fps: Fraction, width: int = 1920, height: int = 1080):
        self.fps = fps
        self.tb, self.ntsc = timebase(fps)
        self.width, self.height = width, height
        self.root = ET.Element("xmeml", version="4")
        self._defined: set[str] = set()
        self._seq = 0

    def frames(self, seconds: float) -> int:
        return int(round(seconds * float(self.fps)))

    def span(self, src: Source) -> tuple[int, int]:
        """[start, end) of a source on the sequence, in frames."""
        start = self.frames(src.start)
        avail = max(0.0, src.duration - src.in_point)
        return start, start + int(math.floor(avail * float(self.fps)))

    def _rate(self, parent: ET.Element) -> None:
        r = _sub(parent, "rate")
        _sub(r, "timebase", self.tb)
        _sub(r, "ntsc", self.ntsc)

    def _file(self, parent: ET.Element, src: Source) -> None:
        fid = f"file-{src.id}"
        if fid in self._defined:
            _sub(parent, "file", id=fid)
            return
        self._defined.add(fid)
        f = _sub(parent, "file", id=fid)
        _sub(f, "name", src.path.name)
        _sub(f, "pathurl", pathurl(src.path))
        self._rate(f)
        _sub(f, "duration", self.frames(src.duration))
        media = _sub(f, "media")
        if src.kind == "video":
            sc = _sub(_sub(media, "video"), "samplecharacteristics")
            self._rate(sc)
            _sub(sc, "width", src.width)
            _sub(sc, "height", src.height)
        if src.audio_channels:
            audio = _sub(media, "audio")
            sc = _sub(audio, "samplecharacteristics")
            _sub(sc, "depth", 16)
            _sub(sc, "samplerate", src.audio_rate)
            _sub(audio, "channelcount", src.audio_channels)

    def _clip(self, track: ET.Element, cid: str, src: Source, start: int, end: int, src_in: int,
              mediatype: str, enabled: bool = True, links: list[tuple[str, str, int]] = ()) -> None:
        c = _sub(track, "clipitem", id=cid)
        _sub(c, "masterclipid", f"master-{src.id}")
        _sub(c, "name", src.path.name)
        _sub(c, "enabled", enabled)
        _sub(c, "duration", self.frames(src.duration))
        self._rate(c)
        _sub(c, "start", start)
        _sub(c, "end", end)
        _sub(c, "in", src_in)
        _sub(c, "out", src_in + (end - start))
        self._file(c, src)
        st = _sub(c, "sourcetrack")
        _sub(st, "mediatype", mediatype)
        if mediatype == "audio":
            _sub(st, "trackindex", 1)  # channel 1: the stems are dual-mono
        for ref, mtype, tindex in links:
            link = _sub(c, "link")
            _sub(link, "linkclipref", ref)
            _sub(link, "mediatype", mtype)
            _sub(link, "trackindex", tindex)
            _sub(link, "clipindex", 1)

    def _sequence(self, name: str, duration: int, markers: list[Marker]) -> tuple[ET.Element, ET.Element]:
        self._seq += 1
        seq = _sub(self.root, "sequence", id=f"sequence-{self._seq}")
        _sub(seq, "name", name)
        _sub(seq, "duration", duration)
        self._rate(seq)
        tc = _sub(seq, "timecode")
        self._rate(tc)
        _sub(tc, "string", "00:00:00:00")
        _sub(tc, "frame", 0)
        _sub(tc, "displayformat", "NDF")
        media = _sub(seq, "media")
        video = _sub(media, "video")
        sc = _sub(_sub(video, "format"), "samplecharacteristics")
        self._rate(sc)
        _sub(sc, "width", self.width)
        _sub(sc, "height", self.height)
        _sub(sc, "pixelaspectratio", "square")
        _sub(sc, "fielddominance", "none")
        audio = _sub(media, "audio")
        _sub(audio, "numOutputChannels", 2)
        asc = _sub(_sub(audio, "format"), "samplecharacteristics")
        _sub(asc, "depth", 16)
        _sub(asc, "samplerate", 48000)
        for m in markers:
            mk = _sub(seq, "marker")
            _sub(mk, "name", m.name)
            _sub(mk, "comment", m.comment)
            _sub(mk, "in", m.frame)
            _sub(mk, "out", -1)
        return video, audio

    # ── the two sequences ────────────────────────────────────────────────────

    def synced_stack(self, name: str, cams: list[Source], mics: list[Source], markers: list[Marker] = ()) -> None:
        """V1–V3 cameras and A1–A3 mics at their sync offsets; A4–A6 each camera's scratch
        audio, linked to its picture and disabled, so sync can be checked by ear."""
        duration = min(self.span(s)[1] for s in cams + mics)
        video, audio = self._sequence(name, duration, list(markers))
        n_mics = len(mics)
        for i, cam in enumerate(cams, 1):
            start = self.frames(cam.start)
            end = min(duration, self.span(cam)[1])
            cin = self.frames(cam.in_point)
            vid, aid = f"{cam.id}-v", f"{cam.id}-a"
            links = [(vid, "video", i), (aid, "audio", n_mics + i)]
            self._clip(_sub(video, "track"), vid, cam, start, end, cin, "video", True, links)
        for mic in mics:
            start = self.frames(mic.start)
            end = min(duration, self.span(mic)[1])
            min_pt = self.frames(mic.in_point)
            self._clip(_sub(audio, "track"), f"{mic.id}-a", mic, start, end, min_pt, "audio")
        for i, cam in enumerate(cams, 1):
            start = self.frames(cam.start)
            end = min(duration, self.span(cam)[1])
            cin = self.frames(cam.in_point)
            links = [(f"{cam.id}-v", "video", i), (f"{cam.id}-a", "audio", n_mics + i)]
            self._clip(_sub(audio, "track"), f"{cam.id}-a", cam, start, end, cin, "audio", False, links)

    def auto_cut(self, name: str, cams: list[Source], mics: list[Source], shots: list[Shot], markers: list[Marker] = ()) -> None:
        """Every camera track bladed at every shot boundary; only the on-screen camera's
        piece is enabled, so an editor swaps an angle by toggling two clips."""
        duration = min(self.span(s)[1] for s in cams + mics)
        video, audio = self._sequence(name, duration, list(markers))
        for cam in cams:
            track = _sub(video, "track")
            c0 = self.frames(cam.start)
            c1 = min(duration, self.span(cam)[1])
            cin = self.frames(cam.in_point)
            for n, shot in enumerate(shots):
                s, e = max(shot.start, c0), min(shot.end, c1)
                if e <= s:
                    continue  # this camera wasn't rolling during the shot
                self._clip(track, f"{cam.id}-v-{n}", cam, s, e, cin + (s - c0), "video", shot.camera == cam.id)
        for mic in mics:
            start = self.frames(mic.start)
            end = min(duration, self.span(mic)[1])
            min_pt = self.frames(mic.in_point)
            self._clip(_sub(audio, "track"), f"{mic.id}-cut-a", mic, start, end, min_pt, "audio")

    def write(self, path: Path) -> None:
        ET.indent(self.root, space="  ")
        body = ET.tostring(self.root, encoding="unicode")
        path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + "\n", encoding="utf-8")
