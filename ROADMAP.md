# RoughCut vs AutoEdit: gap analysis and build plan

_Drafted 2026-10-20. Sources: `~/Developer/Roughcut` (HANDOVER.md, src/), the unpacked AutoEdit 2.12.3 installer, and autoeditai.net._

---

## 1. What AutoEdit actually is (from the installer)

| Layer | What's inside | Takeaway for us |
|---|---|---|
| Panel | **CEP** extension (not UXP), React + Remotion bundle (3 MB), Node enabled | CEP can spawn binaries; UXP can't. That one difference shapes our whole design. |
| Host scripts | 37 ExtendScript files (31k lines): `timeline.jsx` (razor + disable), `captions`, `mogrt-captions`, `zooms`, `auto-reframe`, `broll`, `sfx-apply`, `music-apply`, `isolation-apply`, `dub-apply`, `highlights-apply`, `recap-*`, `mv-*` | Its feature list. The cutting method (razor, then disable or ripple) is the same one RoughCut already uses. |
| Local binaries | `whisper-engine` (whisper.cpp), `broll-analyzer`, `autoedit-recorder` (screen capture) | Only transcription runs locally. |
| Cloud | `api.autoeditai.net`: Claude calls, the music/SFX/b-roll libraries, login, usage metering | All the "AI" goes through their server, which is why it needs an account and a subscription. |

**Their UI patterns, from the bundle strings:** a home grid of tools (Creator Mode, Podcast Mode, Chat Edit, Captions, Zooms, Auto Reframe, B-roll, SFX, Music, Paste Image, Highlights, Translate & Dub, Clean Audio); a mode picker with platform presets (TikTok, Shorts, Reels); a **Review Edits** screen with "Jump to this segment" and "Merge with next"; "Only keep last takes"; Safety Guides / protected ranges; Recent Edits (undo history); Project DNA (learned style); and first-run nudges ("Make your first silence cut").

## 2. Feature gap

✅ have it · 🟡 partial · ❌ missing

| AutoEdit feature | RoughCut today | Gap |
|---|---|---|
| Transcription | 🟡 Reads Premiere's own transcript only | ❌ No own STT. Premiere's transcript has no speaker labels and drops "um/uh". |
| Silence removal | 🟡 Detects pauses from transcript gaps, writes markers | ❌ Doesn't cut. ❌ No audio-level detection. |
| Filler-word removal | 🟡 Markers only | ❌ Needs word-level timestamps that keep fillers (verbatim whisper). |
| Bad-take / repetition removal | ❌ | ❌ Core paid feature (LLM over transcript). |
| Chat Edit ("cut the intro, keep the 2nd take") | ❌ | ❌ |
| Review Edits screen | 🟡 Marker list with checkboxes | Needs a segment timeline view, jump-to, merge, keep/drop toggles. |
| Apply cuts (ripple) | 🟡 Blade + disable on a clone | ❌ No ripple-delete / "close gaps" pass. |
| Podcast multicam | ✅ Auto-Cut, cadence profiles, cold open | 🟡 No real diarization, so it falls back to rotation. **We can beat them here.** |
| Highlights / Shorts | ✅ Cold Open Finder, social clips | 🟡 No vertical output. |
| Auto Reframe 9:16 | ❌ | ❌ Face tracking → position keyframes. |
| Zooms / punch-ins | 🟡 Phase 2 code, not yet verified in Premiere | Verify Probe A. |
| Animated captions | ❌ | ❌ Caption track + MOGRT styles. |
| SFX / Music / B-roll libraries | ❌ | ❌ Use a local folder library instead of their cloud. |
| Paste Image | ❌ | Easy win. |
| Clean Audio | ❌ | Call Premiere's own Enhance Speech if exposed, or run a local denoiser. |
| Translate & Dub, Music Video, Event Recap, Screen Recorder | ❌ | **Skip.** Off-niche. |
| Account, usage meter, upsells | n/a | **Don't build.** Free, local, no sign-up. |

**Where RoughCut is already ahead:** an eval harness against real FCP XML edits, a non-destructive clone-first workflow, Energy Reset cold opens, and J/L split edits.

## 3. Target architecture: "local API" companion

UXP panels **cannot run binaries**, but they **can `fetch` localhost**. So RoughCut gets a small companion service:

```
Premiere ── RoughCut UXP panel (React, existing)
               │  fetch http://127.0.0.1:7317
               ▼
        roughcut-engine  (local helper, no cloud, no account)
          ├─ /transcribe   whisper.cpp (Metal) → words + timestamps, fillers kept
          ├─ /diarize      sherpa-onnx or pyannote → speaker turns  ← fixes Auto-Cut
          ├─ /silences     ffmpeg silencedetect / RMS on the actual audio
          ├─ /llm          Ollama (Qwen/Llama), or Claude with your own key
          ├─ /faces        Apple Vision / MediaPipe → reframe boxes per second
          ├─ /broll/search local CLIP embeddings over your b-roll folder
          └─ /library      indexes your SFX / music / MOGRT folders
```

- The panel gets each clip's media file path from Premiere and sends the **path**, not the file. Nothing leaves the machine.
- Manifest: add `http://127.0.0.1:7317` to `network.domains`.
- The helper starts at login (a launchd agent) or from a menubar app. If it isn't running, the panel shows "Start RoughCut Engine". Every feature still works in degraded mode on Premiere's own transcript.
- Results are cached per media file hash, so a re-run is instant.

## 4. UI/UX: copy the patterns, not the product

Fine to copy: the **workflow and layout ideas** (tool grid, review-before-apply, chat box, platform presets, segment list with jump/merge). Those are common UX patterns.
Not fine to copy: their JS bundle, `.mogrt`/`.aef` presets, music and SFX files, logo, or copy text. Those are proprietary and covered by their EULA. Build your own MOGRT caption templates (2–3 styles is enough to start). Inter is OFL-licensed, so it's fine to use.

Proposed panel flow, kept in RoughCut's existing graphite/amber neumorphic style:

1. **Home**: mode cards (Talking Head, Podcast, Shorts) plus a tools grid. An engine status dot sits top-right.
2. **Analyse**: one button. A progress list (Transcribe → Speakers → Silences → AI pass) with live steps.
3. **Review**: transcript-style list of segments. Strikethrough marks a cut, and each one shows a reason chip (silence / filler / retake / off-topic). Click to jump the playhead. Toggle to keep. "Keep last take only" switch. Aggressiveness slider. A chat box at the bottom ("keep the joke about the dog").
4. **Apply**: always to a **new sequence** (`… – RoughCut`), with one undo step. A summary shows time removed and cut count.
5. **Finish tools**: Captions, Zooms, Reframe 9:16, SFX on cuts, Music bed, B-roll suggestions.

## 5. Phased build plan

Each phase is one PR to `jimbrouw/banans` and ships on its own.

| # | Phase | Delivers | Risk |
|---|---|---|---|
| 0 | **Finish what's open** | Run the Phase 0 API spike in UDT (scale keyframes, audio items, MOGRT). Probe `Project.importFiles` on an .xml and ripple-delete availability. Split `App.tsx` (528 lines, all state) into screens. | Low. Gates 3, 5, 6. |
| 1 | **Local engine v1** ✅ (mlx-whisper instead of whisper.cpp) | `roughcut-engine` service + `/transcribe` (whisper.cpp, word timestamps, verbatim fillers) + `/silences` (ffmpeg). Panel health check and engine status UI. | Medium (packaging) |
| 2 | **Review screen** ✅ (now on Premiere's transcript first; engine optional) | The new Review UX from §4, wired to existing `analyse.ts` decisions plus the new word-level data. | Low |
| 3 | **Real cutting** ✅ 3b XML path built (3a ripple pending Probe D) | Apply kept segments to a new sequence: either (a) blade + ripple-delete in UXP if the spike says yes, or (b) generate FCP XML and import it (reuses `fast-xml-parser` + `eval/fcpXmlReference.ts`). Silence + filler cuts with padding/handles. | **Highest**: depends on UXP API |
| 4 | **AI pass** ✅ (quality on real footage not yet measured) | `/llm`: bad takes, repetitions, "keep last take", off-topic, plus Chat Edit. Ollama by default, Claude key optional. Same JSON contract as `coldOpenFinder.ts`. Score it with the eval harness. | Medium (local model quality) |
| 5 | **Podcast Mode upgrade** ✅ (Premiere labels first, mic-level fallback; not yet tuned on real recordings) | `/diarize` + audio-energy active-speaker detection, so Auto-Cut uses real speakers instead of rotation. Auto speaker→camera mapping from clip names. | Medium |
| 6 | **Captions + Zooms** | Caption track from words, 2–3 own MOGRT styles, word-pop/karaoke. Auto zooms on emphasis beats (reuses Phase 2 punch-ins). | Medium (MOGRT API) |
| 7 | **Reframe + Shorts** | `/faces` → 9:16 sequence with position keyframes. Cold Open / highlights export straight to vertical. | Medium |
| 8 | **Libraries** | Your own SFX/music/b-roll folders indexed locally. SFX on cuts (whoosh/pop), music bed with ducking, b-roll suggestions by transcript↔CLIP match. Paste Image. | Low |

**"Better than AutoEdit" in concrete terms:** free and offline; real diarization in Podcast Mode; a review step that explains *why* each cut was made; never touches the original sequence; cold opens with Energy Reset pacing; an eval harness that measures accuracy against your real edits; and a Project DNA equivalent from your FCP XML references (style profile already extracted in `eval-output/`).

## 6. Decisions (2026-10-20)

- **AI:** Ollama local by default; an optional Claude key unlocks better quality.
- **Engine:** Python service (FastAPI on 127.0.0.1:7317, packaged with `uv`): whisper.cpp via `pywhispercpp`, `pyannote`/`sherpa-onnx`, `open_clip`, `mediapipe`, ffmpeg.
- **Platform:** Mac only (Apple Silicon, Metal).
- **Focus:** all three (podcasts, talking-head, shorts). The phase order above stays: talking-head cuts (1–4) first, because Podcast Mode already exists; then diarization (5); then shorts (6–7).

- **Engine location:** `engine/` folder inside this repo (`jimbrouw/banans`).
