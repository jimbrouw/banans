"""Configuration manager for RoughCut Ingest & Auto-Cut.

Saves preferences to ~/Library/Application Support/RoughCut/config.json.
Allows users to specify an external drive or local directory for overnight downloads.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

CONFIG_FILE = Path.home() / "Library/Application Support/RoughCut/config.json"


@dataclass
class IngestConfig:
    # Target directory on an external SSD or local disk for overnight downloads
    local_download_dir: str = ""
    # Filespace details
    filespace_id: str = "77292657-00c2-4460-b955-5885a36ddfe1"
    mount_path: str = "/Volumes/specialized2026/studio"
    cloud_output_dir: str = "/Studio Recordings/RoughCut Auto Cuts"
    # Studio hardware calibration (frames to advance audio; negative delays audio relative to video)
    clap_sync_offset_frames: int = -4
    # 4K Masters Overnight Ingest options
    download_masters_overnight: bool = True
    masters_cloud_dir: str = "/Studio Recordings/Just-In Masters"
    masters_subfolder_name: str = "Master 4K"
    masters_custom_dir: str = ""
    # Options
    auto_download_to_local: bool = True
    mirror_xml_to_cloud: bool = True
    auto_open_in_premiere: bool = True
    auto_import_premiere: bool = True

    @classmethod
    def load(cls) -> IngestConfig:
        if CONFIG_FILE.is_file():
            try:
                data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
            except Exception:
                pass
        return cls()

    def save(self) -> None:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
