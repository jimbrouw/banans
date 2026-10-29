"""Desktop GUI for RoughCut Overnight Ingest & Auto-Cut.

Designed with high-contrast, clean typography and native macOS styling.
Avoids native Tkinter Aqua white-on-white button rendering defects.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .config import IngestConfig
from .lucid_watcher import LucidWatcher, WatchConfig, StateStore, process_batch, State


class ActionButton(tk.Label):
    """High-contrast, beautifully styled clickable button that bypasses macOS Tkinter Aqua bugs."""

    def __init__(
        self,
        parent,
        text: str,
        command=None,
        bg: str = "#30363d",
        fg: str = "#ffffff",
        hover_bg: str = "#3c444d",
        font: tuple = ("SF Pro Text", 11, "bold"),
        padx: int = 14,
        pady: int = 7,
        **kwargs,
    ):
        super().__init__(
            parent,
            text=text,
            bg=bg,
            fg=fg,
            font=font,
            cursor="pointinghand",
            padx=padx,
            pady=pady,
            relief="solid",
            borderwidth=1,
            **kwargs,
        )
        self.command = command
        self.default_bg = bg
        self.default_fg = fg
        self.hover_bg = hover_bg
        self.is_enabled = True

        self.bind("<Button-1>", self._on_click)
        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)

    def _on_click(self, event=None):
        if self.is_enabled and self.command:
            self.command()

    def _on_enter(self, event=None):
        if self.is_enabled:
            self.configure(bg=self.hover_bg)

    def _on_leave(self, event=None):
        if self.is_enabled:
            self.configure(bg=self.default_bg)

    def set_enabled(self, enabled: bool):
        self.is_enabled = enabled
        if enabled:
            self.configure(bg=self.default_bg, fg=self.default_fg, cursor="pointinghand")
        else:
            self.configure(bg="#21262d", fg="#6e7681", cursor="arrow")

    def set_style(self, text: str, bg: str, fg: str, hover_bg: str):
        self.default_bg = bg
        self.default_fg = fg
        self.hover_bg = hover_bg
        self.configure(text=text, bg=bg, fg=fg)


class DropdownSelector(tk.Frame):
    """Sleek dark-themed dropdown button with popup menu, zero white-on-white native bugs."""

    def __init__(self, parent, variable: tk.StringVar, values: list[str] | None = None, on_select=None, **kwargs):
        super().__init__(parent, bg="#161b22", **kwargs)
        self.variable = variable
        self.on_select = on_select
        self.values = values or []

        self.display_var = tk.StringVar()
        self._update_display()
        self.variable.trace_add("write", lambda *args: self._update_display())

        self.lbl = tk.Label(
            self,
            textvariable=self.display_var,
            bg="#21262d",
            fg="#ffffff",
            font=("SF Pro Text", 12, "bold"),
            padx=14,
            pady=7,
            relief="solid",
            borderwidth=1,
            highlightbackground="#e5a93b",
            highlightthickness=1,
            cursor="pointinghand",
        )
        self.lbl.pack(side="left")

        self.menu = tk.Menu(
            self,
            tearoff=0,
            bg="#1c2128",
            fg="#ffffff",
            activebackground="#e5a93b",
            activeforeground="#000000",
            font=("SF Pro Text", 12, "bold"),
            relief="solid",
            borderwidth=1,
        )

        self.lbl.bind("<Button-1>", self._popup)
        self.lbl.bind("<Enter>", lambda e: self.lbl.configure(bg="#30363d"))
        self.lbl.bind("<Leave>", lambda e: self.lbl.configure(bg="#21262d"))
        self.set_values(self.values)

    def _update_display(self):
        val = self.variable.get() or "Select Episode"
        self.display_var.set(f"{val}   ▾")

    def _popup(self, event):
        x = self.lbl.winfo_rootx()
        y = self.lbl.winfo_rooty() + self.lbl.winfo_height() + 2
        self.menu.tk_popup(x, y)

    def set_values(self, values: list[str]):
        self.values = values
        self.menu.delete(0, "end")
        for val in values:
            self.menu.add_command(label=f"  {val}  ", command=lambda v=val: self._select(v))

    def _select(self, val: str):
        self.variable.set(val)
        if self.on_select:
            self.on_select(val)


class IngestApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("RoughCut Ingest & Overnight Auto-Cut")
        self.geometry("740x820")
        self.minsize(680, 720)
        self.configure(bg="#0d1117")

        self.cfg = IngestConfig.load()
        self.watch_cfg = WatchConfig()
        self.store = StateStore()
        self.watcher_thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.last_batch_output: str | None = None

        self._build_ui()
        self._populate_episodes()
        self._refresh_status()

    def _build_ui(self):
        # ── 1. Header ──────────────────────────────────────────
        hdr_frame = tk.Frame(self, bg="#0d1117")
        hdr_frame.pack(fill="x", padx=22, pady=(20, 8))

        hdr = tk.Label(
            hdr_frame,
            text="RoughCut Ingest & Multi-Cam Pipeline",
            font=("SF Pro Display", 20, "bold"),
            fg="#e5a93b",
            bg="#0d1117",
        )
        hdr.pack(anchor="w")

        sub = tk.Label(
            hdr_frame,
            text="Automated overnight cloud download from LucidLink (US) to your local drive (UK).",
            font=("SF Pro Text", 12),
            fg="#8b949e",
            bg="#0d1117",
        )
        sub.pack(anchor="w", pady=(3, 0))

        # ── 2. Destination Drive Box ────────────────────────────
        dest_box = tk.LabelFrame(
            self,
            text=" 1. External Drive / Local Storage Destination ",
            bg="#161b22",
            fg="#e5a93b",
            font=("SF Pro Text", 11, "bold"),
            padx=14,
            pady=12,
            relief="solid",
            borderwidth=1,
        )
        dest_box.pack(fill="x", padx=22, pady=8)

        self.dir_var = tk.StringVar(value=self.cfg.local_download_dir or "No drive selected (Streaming directly from LucidLink)")
        dir_lbl = tk.Label(
            dest_box,
            textvariable=self.dir_var,
            bg="#161b22",
            fg="#58a6ff",
            anchor="w",
            font=("Menlo", 11, "bold"),
        )
        dir_lbl.pack(fill="x", side="left", expand=True, padx=(4, 10))

        browse_btn = ActionButton(
            dest_box,
            text="Browse Drive...",
            command=self._choose_dir,
            bg="#21262d",
            fg="#ffffff",
            hover_bg="#30363d",
            padx=12,
            pady=5,
        )
        browse_btn.pack(side="right")

        # ── 3. Episode Selector & Immediate Cut ─────────────────
        ep_box = tk.LabelFrame(
            self,
            text=" 2. Select Episode & Immediate Cut ",
            bg="#161b22",
            fg="#e5a93b",
            font=("SF Pro Text", 11, "bold"),
            padx=14,
            pady=12,
            relief="solid",
            borderwidth=1,
        )
        ep_box.pack(fill="x", padx=22, pady=8)

        top_ep = tk.Frame(ep_box, bg="#161b22")
        top_ep.pack(fill="x")

        tk.Label(
            top_ep,
            text="Episode on LucidLink:",
            bg="#161b22",
            fg="#f0f6fc",
            font=("SF Pro Text", 12, "bold"),
        ).pack(side="left")

        self.ep_var = tk.StringVar(value="2026-10-21 17-35-23")
        self.ep_dropdown = DropdownSelector(top_ep, variable=self.ep_var)
        self.ep_dropdown.pack(side="left", padx=12)

        refresh_btn = ActionButton(
            top_ep,
            text="Refresh List",
            command=self._populate_episodes,
            bg="#21262d",
            fg="#ffffff",
            hover_bg="#30363d",
            padx=10,
            pady=6,
        )
        refresh_btn.pack(side="left")

        # Buttons row
        btn_row = tk.Frame(ep_box, bg="#161b22")
        btn_row.pack(fill="x", pady=(14, 2))

        self.sync_btn = ActionButton(
            btn_row,
            text="Sync & Cut Selected Episode Now",
            command=self._sync_latest_now,
            bg="#e5a93b",
            fg="#000000",
            hover_bg="#f0b84c",
            font=("SF Pro Text", 13, "bold"),
            padx=18,
            pady=9,
        )
        self.sync_btn.pack(side="left")

        self.open_prem_btn = ActionButton(
            btn_row,
            text="Open in Premiere Pro",
            command=self._open_in_premiere,
            bg="#21262d",
            fg="#ffffff",
            hover_bg="#30363d",
            font=("SF Pro Text", 12, "bold"),
            padx=14,
            pady=8,
        )
        self.open_prem_btn.pack(side="left", padx=12)

        # ── Visual Progress Indicator ──
        self.prog_frame = tk.Frame(ep_box, bg="#161b22")
        self.prog_frame.pack(fill="x", pady=(14, 4))

        prog_top = tk.Frame(self.prog_frame, bg="#161b22")
        prog_top.pack(fill="x")

        self.prog_msg = tk.Label(
            prog_top,
            text="Status: Ready",
            bg="#161b22",
            fg="#8b949e",
            font=("SF Pro Text", 11, "bold"),
        )
        self.prog_msg.pack(side="left")

        self.prog_pct = tk.Label(
            prog_top,
            text="0%",
            bg="#161b22",
            fg="#e5a93b",
            font=("Menlo", 12, "bold"),
        )
        self.prog_pct.pack(side="right")

        self.progress_bar = ttk.Progressbar(
            self.prog_frame,
            orient="horizontal",
            mode="determinate",
            maximum=100,
        )
        self.progress_bar.pack(fill="x", pady=(6, 2))

        # ── 4. Overnight Automation Box ─────────────────────────
        auto_box = tk.LabelFrame(
            self,
            text=" 3. Overnight Hands-Free Automation ",
            bg="#161b22",
            fg="#e5a93b",
            font=("SF Pro Text", 11, "bold"),
            padx=14,
            pady=12,
            relief="solid",
            borderwidth=1,
        )
        auto_box.pack(fill="x", padx=22, pady=8)

        self.dl_var = tk.BooleanVar(value=self.cfg.auto_download_to_local)
        dl_chk = tk.Checkbutton(
            auto_box,
            text="Download proxies & mic stems locally overnight (speeds up rough cut)",
            variable=self.dl_var,
            command=self._save_options,
            bg="#161b22",
            fg="#f0f6fc",
            selectcolor="#0d1117",
            activebackground="#161b22",
            activeforeground="#ffffff",
            font=("SF Pro Text", 11),
        )
        dl_chk.pack(anchor="w")

        self.masters_var = tk.BooleanVar(value=getattr(self.cfg, "download_masters_overnight", True))
        masters_chk = tk.Checkbutton(
            auto_box,
            text="Download 4K Masters overnight into 'Master 4K' folder (runs in background after cut is done)",
            variable=self.masters_var,
            command=self._save_options,
            bg="#161b22",
            fg="#58a6ff",
            selectcolor="#0d1117",
            activebackground="#161b22",
            activeforeground="#58a6ff",
            font=("SF Pro Text", 11, "bold"),
        )
        masters_chk.pack(anchor="w", pady=(3, 0))

        # Hardware Clap & Latency Calibration Row
        hw_row = tk.Frame(auto_box, bg="#161b22")
        hw_row.pack(fill="x", pady=(5, 2))

        tk.Label(
            hw_row,
            text="Studio Clap / Video Offset:",
            bg="#161b22",
            fg="#f0f6fc",
            font=("SF Pro Text", 11),
        ).pack(side="left")

        self.clap_offset_var = tk.StringVar(value=str(getattr(self.cfg, "clap_sync_offset_frames", 11)))
        clap_entry = tk.Entry(
            hw_row,
            textvariable=self.clap_offset_var,
            width=4,
            font=("Menlo", 11, "bold"),
            bg="#0d1117",
            fg="#e5a93b",
            insertbackground="#ffffff",
            relief="solid",
            borderwidth=1,
            justify="center",
        )
        clap_entry.pack(side="left", padx=6)
        clap_entry.bind("<FocusOut>", lambda e: self._save_options())
        clap_entry.bind("<Return>", lambda e: self._save_options())

        tk.Label(
            hw_row,
            text="frames (advances audio to match Sony FX30 / Zoom capture delay)",
            bg="#161b22",
            fg="#8b949e",
            font=("SF Pro Text", 10),
        ).pack(side="left")

        self.mirror_var = tk.BooleanVar(value=self.cfg.mirror_xml_to_cloud)
        mirror_chk = tk.Checkbutton(
            auto_box,
            text="Mirror generated RoughCut XML back to LucidLink for US team",
            variable=self.mirror_var,
            command=self._save_options,
            bg="#161b22",
            fg="#f0f6fc",
            selectcolor="#0d1117",
            activebackground="#161b22",
            activeforeground="#ffffff",
            font=("SF Pro Text", 11),
        )
        mirror_chk.pack(anchor="w", pady=(3, 0))

        self.auto_prem_var = tk.BooleanVar(value=getattr(self.cfg, "auto_open_in_premiere", True))
        prem_chk = tk.Checkbutton(
            auto_box,
            text="Automatically open sequence in Premiere Pro when done",
            variable=self.auto_prem_var,
            command=self._save_options,
            bg="#161b22",
            fg="#f0f6fc",
            selectcolor="#0d1117",
            activebackground="#161b22",
            activeforeground="#ffffff",
            font=("SF Pro Text", 11),
        )
        prem_chk.pack(anchor="w", pady=(3, 0))

        status_row = tk.Frame(auto_box, bg="#161b22")
        status_row.pack(fill="x", pady=(12, 2))

        self.status_lbl = tk.Label(
            status_row,
            text="Status: IDLE",
            font=("SF Pro Text", 12, "bold"),
            fg="#8b949e",
            bg="#161b22",
        )
        self.status_lbl.pack(side="left")

        self.toggle_btn = ActionButton(
            status_row,
            text="Start Overnight Watcher",
            command=self._toggle_watcher,
            bg="#238636",
            fg="#ffffff",
            hover_bg="#2ea043",
            font=("SF Pro Text", 12, "bold"),
            padx=14,
            pady=6,
        )
        self.toggle_btn.pack(side="right")

        # ── 5. Live Activity Log ────────────────────────────────
        log_frame = tk.LabelFrame(
            self,
            text=" Live Log & Activity ",
            bg="#161b22",
            fg="#8b949e",
            font=("SF Pro Text", 10, "bold"),
            padx=10,
            pady=10,
            relief="solid",
            borderwidth=1,
        )
        log_frame.pack(fill="both", expand=True, padx=22, pady=(6, 16))

        self.log_text = tk.Text(
            log_frame,
            bg="#0d1117",
            fg="#c9d1d9",
            insertbackground="#ffffff",
            font=("Menlo", 11),
            wrap="word",
            relief="flat",
            padx=8,
            pady=8,
        )
        self.log_text.pack(fill="both", expand=True, side="left")

        scroll = tk.Scrollbar(log_frame, command=self.log_text.yview, bg="#161b22")
        scroll.pack(side="right", fill="y")
        self.log_text.config(yscrollcommand=scroll.set)

    def log(self, msg: str):
        def _append():
            ts = time.strftime("%H:%M:%S")
            self.log_text.insert("end", f"[{ts}] {msg}\n")
            self.log_text.see("end")

        self.after(0, _append)

    def set_progress(self, pct: float, msg: str):
        def _update():
            self.progress_bar["value"] = pct
            self.prog_pct.config(text=f"{int(pct)}%")
            color = "#3fb950" if pct >= 100 else "#58a6ff" if pct > 0 else "#8b949e"
            self.prog_msg.config(text=msg, fg=color)
            ts = time.strftime("%H:%M:%S")
            self.log_text.insert("end", f"[{ts}] [{int(pct)}%] {msg}\n")
            self.log_text.see("end")

        self.after(0, _update)

    def _choose_dir(self):
        chosen = filedialog.askdirectory(title="Select External Drive or Local Folder for Media & XMLs")
        if chosen:
            self.cfg.local_download_dir = chosen
            self.cfg.save()
            self.dir_var.set(chosen)
            self.log(f"Destination drive set to: {chosen}")

    def _save_options(self):
        self.cfg.auto_download_to_local = self.dl_var.get()
        self.cfg.download_masters_overnight = self.masters_var.get()
        self.cfg.mirror_xml_to_cloud = self.mirror_var.get()
        self.cfg.auto_open_in_premiere = self.auto_prem_var.get()
        try:
            self.cfg.clap_sync_offset_frames = int(self.clap_offset_var.get().strip())
        except Exception:
            self.cfg.clap_sync_offset_frames = 11
        self.cfg.save()

    def _populate_episodes(self):
        batches = self.store.load()
        complete = [k for k, b in batches.items() if len(b.members) == 6]
        complete.sort(reverse=True)

        if complete:
            self.ep_dropdown.set_values(complete)
            if not self.ep_var.get() or self.ep_var.get() not in complete:
                default_choice = "2026-10-21 17-35-23" if "2026-10-21 17-35-23" in complete else complete[0]
                self.ep_var.set(default_choice)
            self.log(f"Found {len(complete)} complete episodes in LucidLink. Selected: {self.ep_var.get()}")
        else:
            self.ep_dropdown.set_values(["No complete episodes found"])
            self.ep_var.set("No complete episodes found")

    def _toggle_watcher(self):
        if self.watcher_thread and self.watcher_thread.is_alive():
            self.stop_event.set()
            self.status_lbl.config(text="Status: STOPPING...", fg="#e5a93b")
            self.toggle_btn.set_style("Start Overnight Watcher", bg="#238636", fg="#ffffff", hover_bg="#2ea043")
            self.log("Stopping background watcher...")
        else:
            self.stop_event.clear()
            self.watcher_thread = threading.Thread(target=self._run_watcher, daemon=True)
            self.watcher_thread.start()
            self.status_lbl.config(text="Status: WATCHING (Overnight Active)", fg="#3fb950")
            self.toggle_btn.set_style("Stop Watcher", bg="#da3633", fg="#ffffff", hover_bg="#f85149")
            self.log("Overnight Watcher started. Monitoring filespace 'studio.specialized2026'...")

    def _run_watcher(self):
        def on_ready(b):
            self.log(f"New completed batch detected: {b.key}! Starting download & auto-cut...")
            process_batch(b, self.watch_cfg, self.store, progress_callback=self.set_progress)
            self.last_batch_output = b.output
            self.log(f"Finished {b.key}! XML ready: {b.output}")
            if self.auto_prem_var.get():
                self.log("Automatically opening in Adobe Premiere Pro...")
                self._open_in_premiere()

        watcher = LucidWatcher(self.watch_cfg, self.store, on_ready=on_ready)
        try:
            watcher.run(self.stop_event)
        except Exception as e:
            self.log(f"Watcher error: {e}")
        finally:
            self.after(0, lambda: self.status_lbl.config(text="Status: IDLE", fg="#8b949e"))
            self.after(0, lambda: self.toggle_btn.set_style("Start Overnight Watcher", bg="#238636", fg="#ffffff", hover_bg="#2ea043"))

    def _refresh_status(self):
        batches = self.store.load()
        if batches:
            latest = list(batches.values())[-1]
            if latest.output:
                self.last_batch_output = latest.output
                self.log(f"Latest batch on disk: {latest.key} ({latest.state.value})")

    def _sync_latest_now(self):
        target_key = self.ep_var.get()
        if not target_key or target_key in ("No complete episodes found", "Loading episodes..."):
            messagebox.showwarning("RoughCut Ingest", "Please select a valid episode to sync & cut.")
            return

        def _worker():
            batches = self.store.load()
            batch = batches.get(target_key)
            if not batch:
                self.log(f"Batch {target_key} not in store. Please start watcher to scan.")
                return

            self.sync_btn.set_enabled(False)
            self.set_progress(1.0, f"Starting pipeline for {target_key}...")
            self.log(f"Target destination: {self.cfg.local_download_dir or 'Streaming directly from LucidLink'}")

            try:
                process_batch(batch, self.watch_cfg, self.store, progress_callback=self.set_progress)
                self.last_batch_output = batch.output
                self.set_progress(100.0, "SUCCESS: Auto Cut V1.xml ready!")
                if self.auto_prem_var.get():
                    self.log("Automatically launching sequence in Adobe Premiere Pro...")
                    self._open_in_premiere()
                else:
                    messagebox.showinfo(
                        "RoughCut Ingest",
                        f"Successfully generated RoughCut for episode:\n{target_key}\n\nXML Location:\n{batch.output}\n\nClick 'Open in Premiere Pro' to view your cut!",
                    )
            except Exception as e:
                self.set_progress(0.0, f"Error: {e}")
                self.log(f"ERROR processing {target_key}: {e}")
                messagebox.showerror("RoughCut Ingest Error", str(e))
            finally:
                self.sync_btn.set_enabled(True)

        threading.Thread(target=_worker, daemon=True).start()

    def _open_in_premiere(self):
        if not self.last_batch_output or not Path(self.last_batch_output).exists():
            messagebox.showwarning("RoughCut Ingest", "No XML sequence has been generated yet.")
            return
        self.log(f"Opening XML in Adobe Premiere Pro: {self.last_batch_output}")
        res = subprocess.run(["open", "-b", "com.adobe.PremierePro.26", self.last_batch_output], capture_output=True)
        if res.returncode != 0:
            subprocess.run(["open", "-a", "Adobe Premiere Pro 2026", self.last_batch_output], capture_output=True)


def main():
    app = IngestApp()
    app.mainloop()


if __name__ == "__main__":
    main()
