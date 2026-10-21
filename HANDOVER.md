# RoughCut – Developer Handover

_Last updated: 2026-07-01_

---

## What is this?

RoughCut is a **Premiere Pro UXP panel plugin** (React 16 + TypeScript + Vite) that automates podcast editing. It reads the sequence transcript from Premiere, analyses it, and produces edit decisions the editor can review before writing anything back to the timeline.

It runs inside the **Adobe UXP runtime** — a sandboxed, browser-like environment embedded in Premiere. The important implication: Node.js APIs don't exist here, and Premiere's scripting API is accessed via `@adobe/premierepro` types backed by the `premierepro` UXP module.

---

## Tech stack

| Layer | Choice |
|---|---|
| UI | React 16, TypeScript, Vite |
| Styling | Plain CSS (`App.css`, `index.css`) — no Tailwind, no CSS modules |
| Icons | `lucide-react` |
| Runtime | Adobe UXP (Premiere Pro ≥ 25.6) |
| AI | Anthropic Messages API — raw `fetch` (not the SDK) |
| Tests | Vitest |

---

## Repo layout

```
src/
  App.tsx                      Shell: header (sequence picker, engine pill), tab bar, shared state
  settings.ts                  Per-machine settings in localStorage: Claude key, AI provider, last tab
  panels/                      One component per tab; feature-local state lives in each
    Chrome.tsx                 SequencePicker (header) + TabBar (tabs show live status)
    ReviewPanel.tsx            Clean up tab: pauses, fillers, retakes, Chat Edit, remove cuts
    MulticamPanel.tsx          Multicam tab: 1 cameras, 2 who's on which camera, 3 cut style
    PodcastMode.tsx            MicSpeakersStep: the "Mic tracks" option in Multicam step 2
    SelectsPanel.tsx           Clips tab: five clips worth cutting, build them, YouTube chapters
    AnalysisPanel.tsx          Clips tab (opt-in "Review markers"): the old marker analysis
    ResultsPanel.tsx           Clips tab: marker list, filters, export, mark on a copy
    ColdOpenPanel.tsx          Clips tab: Cold Open finder (uses the Setup tab's Claude key)
    SetupPanel.tsx             Setup tab: engine status, Claude key, log path, API spike
    SpikePanel.tsx             Premiere API probe runner (Premiere only, in Setup)
    EngineStatus.tsx           Header pill: is the local engine reachable?
  reviewModel.ts               Pure: source→sequence time mapping, cut building/merging, summary
  reviewHost.ts                Premiere reads for review: A1 clips + media paths, set playhead
  reviewDemo.ts                Canned transcript, AI result and mic levels for the browser demo
  podcastSpeakers.ts           Pure: mic loudness → active speaker turns (Podcast Mode fallback)
  xmlCut.ts                    Pure: remove time ranges from a Premiere FCP XML export
  xmlCutHost.ts                Premiere glue: export XML → xmlCut → import → open new sequence
  engineClient.ts              Typed fetch client for the local engine (localhost:7317)
  ui.tsx                       Shared components: Press, Toggle, Options (fold-away settings)
  sequenceNames.ts             Pure: numbered names for generated sequences ("Seq — Auto Cut 03 (…)")
  projectBin.ts                Files generated sequences into the "RoughCut" bin
  runLog.ts                    Run log: one line per action, in the plugin's data folder
  uiHelpers.ts                 markerMeta, platform maps, formatTime, openExternal
  App.css / index.css          Styles
  types.ts                     Shared interfaces
  premiereAdapter.ts           UxpPremiereAdapter — all Premiere API calls
  mockPremiere.ts              MockPremiereAdapter — browser/demo mode
  hostRuntime.ts               getRuntimeRequire() / isPremiereHost()
  analyse.ts                   Pure transcript → EditDecision engine
  autopilot.ts                 Multi-cam cut map generator + evaluator
  cutEngine.ts                 Timeline interval maths
  coldOpenFinder.ts            Claude API integration (hook finding + shot list)
  coldOpenAssembler.ts         Pure logic: shots → CutPoint[]
  spike-coldopen.ts            Phase 0 API probe (scale keyframing, audio access, MOGRT)
  transcriptParse.ts           CSV / SRT / JSON file parser
  eval/                        Evaluation harness
public/
  manifest.json                UXP manifest — permissions live here
engine/                        Local Python companion service (see engine/README.md)
COLD_OPEN_DYNAMIC_PLAN.md      Phased plan for Energy Reset implementation
ROADMAP.md                     AutoEdit gap analysis + phased plan (local engine, cutting, AI pass)
```

---

## Running locally

```bash
npm install
npm run dev        # Vite dev server on localhost:3000
```

In Premiere, open the **UXP Developer Tool (UDT)**, add the plugin from this folder, and **Load** it. The panel connects to the Vite dev server for hot reload.

> **Important**: after changing `public/manifest.json` you must **Unload → Load** in UDT (not just Reload) or the new permissions are not picked up.

```bash
npm test           # Vitest unit tests
npm run build      # Production bundle → dist/
```

---

## Panel layout

Four tabs, all kept mounted so switching never loses work (the last tab is remembered): **Clean up**, **Multicam**, **Clips**, **Setup**. Each tab has one main action; settings most runs don't need sit under a folded **Options** line that summarises them. Once a tab has results, its "find" button shrinks to a link and the next step (remove cuts, cut to a new sequence, mark on a copy) becomes the main button. The tab bar shows live status (`9 cuts`, `3 cams`, `28`). The Claude key is entered once in Setup.

## Clips tab: selects pass

What a senior podcast clip producer does, instead of a pile of markers: read the whole episode, cut five.

```
SelectsPanel "Find the best clips"
  └─ words: Premiere transcript (Whisper fallback) → reviewModel.speechUnits (real sentences: split at
       . ? ! or a ≥1.2 s pause, never at transcriber segment breaks; unpunctuated runs broken at their
       biggest pause, max 20 s)
  └─ engine POST /jobs/selects → background job, polled with GET /jobs/{id} (step text shown in the
       panel); a local model takes 5-10 min and fetch gives up on one response after 5
  └─ selects.run_selects
       1 candidates  model reads all lines in slices of 90 (8B models skim bigger ones) against RUBRIC (the editor's brief +
                     yt-shorts' picking rules): first/last line ids, an optional hook line pulled
                     forward from ≤45 s later, type (story/opinion/tip/moment), idea, title, why
       2 checks      20–60 s, real ids; a passage under 20 s is carried on through the following
                     sentences while speech flows (the model tends to stop before the payoff);
                     contiguous lines merge, pauses ≥1.5 s are cut
       3 signals     liveliness vs the episode's typical level (if the episode audio is one file);
                     hookscore of the opening line, weighted low (it rated this editor's own
                     published openings 34–43 "weak") and shown as a tip
       4 dedupe      overlap >30% of the shorter, or the same idea → keep the better one
       5 rank        every passing candidate goes into Swiss pairwise rounds (≈log2 n + 1, max 6; no
                     rematches, rotating sit-out). No heuristic shortlist: it cut both reference moments
       6 variety     top 5 with each type that has a contender; titles linted (yt-package title.py)
  └─ "Build N clip sequences" → reviewModel.withoutFillers → xmlCutHost.buildClipsViaXml
       (xmlCut.applyPiecesToXml keeps pieces in play order, so a pulled-forward hook plays first)
       → "<seq> — Clip NN (title)" in a Clips bin
  └─ "Make chapters" → engine POST /chapters → yt chapters boundaries (pauses + vocabulary shift,
       YouTube's rules) + model retitles, 6–10 → text to paste
```

- The model only names line ids; all times are computed in code.
- Review markers are opt-in under "Review markers" in the Clips tab.
- Tools from Jake Schincariol's YouTube agent skill pack (MIT) live in `engine/roughcut_engine/yt/` (hookscore, title unmodified; chapters adapted). The full skill pack is also installed as Claude Code skills (`~/.claude/skills/yt-*`).

### Checking the picks against real clips

`npm run eval:selects -- --episode eval-input/<ep> --refs "<folder of clip XMLs>" --episode-name "<edit sequence name>" [--provider claude]`
reads the editor's published clips (FCP XML of each clip sequence; `src/eval/clipReference.ts` maps them to episode time, including pulled-forward hooks), runs the selects pass on `<ep>/transcript.json`, and scores it (`src/eval/selectsEval.ts`): found (pick covers ≥50% of the editor's clip), rank, overlap, edge error, same opening line. Needs Ollama or `ANTHROPIC_API_KEY`. It also prints, for each published clip, every proposal that touched it and its fate (never proposed / too short / dropped as overlap / lost the comparisons / picked), which is how the fixes above were found.

First results on the Kate Courtney episode (qwen3:8b, 2 reference Shorts): 0/2 → 1/2 after four runs. The hit covers 65% of the editor's clip but starts 10 s earlier and ends 12 s earlier: the editor trims the preamble to the strongest line and runs on to the payoff. The miss reached the comparisons but its text is a stretch where Whisper dropped punctuation. Inputs and results are gitignored (they hold media paths and transcript text). The run log records which clips were kept or dropped on every build.

## Active sequence

The panel follows Premiere's Timeline: `App.followTimeline` runs on Premiere's `SequenceEvent.ACTIVATED` and every 1.5 s as a safety net, but never while a logged action is running (`runLog.isRunning`), because actions like Auto Cut open the sequence they create. The picker under "Active sequence" lists every sequence in the project; choosing one calls `premiere.activateSequence`, which opens it in the Timeline. On a switch, results from the previous sequence are cleared (panels are keyed by sequence id), a `Sequence changed` line is logged, and a banner keeps the last "Created …" visible.

## Generated sequences: names, bin, run log

- **Names:** `<source> — <action> <NN> (<details>)`, e.g. `Sequence 01 — Auto Cut 03 (Balanced · 41 cuts · mics)`.
  The run number counts up per source + action (`sequenceNames.nextSequenceName` reads the project's sequence names).
  Running on a generated sequence counts against the original (`sourceBaseName` strips current and legacy suffixes).
  Actions: Auto Cut, Clean-up, Clean-up Markers, Review Markers, Cold Open, Social Cut.
- **Bin:** every generated sequence is moved into a `RoughCut` bin at the project root (created on first use, best-effort).
- **Run log:** `runLog.logged(action, details, fn)` wraps each action and appends one line (OK/FAIL, duration, result, details, error) to
  `roughcut.log` in the plugin's UXP data folder: `~/Library/Application Support/Adobe/UXP/PluginsStorage/PPRO/<version>/Developer/com.roughcut.podcast-assistant.dev/PluginData/roughcut.log`
  (the "Panel opened" line records the exact path). API spike results are logged per probe. In the browser demo, lines go to the console.

## Local engine (`engine/`)

UXP panels can't spawn processes, so anything that needs ffmpeg or an ML model runs in a separate local Python service the panel calls over `http://localhost:7317`.

```
Panel (UXP) ── engineClient.ts ──fetch──▶ roughcut-engine (FastAPI, uv)
                                            ├─ POST /silences   ffmpeg silencedetect
                                            └─ POST /transcribe mlx-whisper, word timestamps, fillers kept
```

- **On demand (normal):** run `engine/install.sh` once. macOS then holds localhost:7317, IPv4 and IPv6 (socket activation, no process) and starts the engine when the panel connects; it quits after 10 idle minutes (`RC_ENGINE_IDLE`). Undo with `engine/uninstall.sh`. Engine output goes to `~/Library/Logs/RoughCut/engine.log`.
- **By hand (development):** `cd engine && uv run roughcut-engine` binds the port itself and stays up.
- The header shows **Engine** (green) or **Engine off**; its 10-second health poll is what wakes the engine, so it stays up while the panel is open.
- The panel passes the clip's media **path** (Probe F checks we can read it); the engine reads the file directly.
- `engineHealth()` returns `null` when the engine is down, and every feature must keep working on Premiere's own transcript in that case.
- **Must be `http://localhost:7317`, never `127.0.0.1`.** Premiere on macOS blocks plain `http://` except to `localhost` (its Info.plist App Transport Security exception). With `127.0.0.1` the panel's requests never left Premiere and the pill showed "Engine off" with no clue why.
- Manifest allows `http://localhost:7317` (needs UDT Unload → Load).
- `EngineStatus` logs every on/off change with Premiere's own error text (`Engine check` lines in the run log).
- The **Clean-up review** panel (ROADMAP Phase 2) is the first consumer, described below.

### Clean-up review flow

```
ReviewPanel "Find pauses & fillers"
  └─ reviewHost.getPrimaryAudioClips()   A1 clips: media path, sequence start/end, source in-point
  └─ words: Premiere's own transcript first (reviewHost.getPremiereTranscriptWords)
  │    sequence transcript, else each A1 clip's transcript placed on the timeline
  │    (transcriptParse.transcriptWordsFromJson keeps word timings; um/uh flagged as fillers)
  │    fallback only if there's none: engine /transcribe (Whisper)
  └─ pauses: engine /silences when the engine is running (measured in the audio),
  │    otherwise gaps between words (reviewModel.gapSilences)
  └─ reviewModel.wordsForClip / mapToSequence   source time → sequence time, per clip
  └─ reviewModel.buildCuts(words, silences, settings)
       ├─ silences ≥ min pause, shrunk by "breathing room" padding
       ├─ never cuts through a non-filler word (silence minus word spans)
       ├─ filler words (if enabled) become cuts
       └─ cuts within 50 ms merge (e.g. "um" + following pause)
  └─ editor toggles cuts (pause chips / struck filler words); click a timestamp → playhead
  └─ "Remove N cuts → new sequence" → xmlCutHost.removeCutsViaXml   (ROADMAP Phase 3b)
  └─ "Or mark them only" → cutsToDecisions → premiere.createRoughCut (markers on a clone)
```

- The review now works **without the engine** when Premiere has transcribed the sequence; the note under the button says which transcript and pause source were used.

### Podcast Mode (ROADMAP Phase 5)

Who's talking, for the multicam autopilot: step 2 of the Multicam tab (`MulticamPanel`), with a Transcript / Mic tracks switch.

1. **Transcript:** Premiere's speaker labels ("Read speakers from transcript" fetches it if the Clips tab hasn't). One row per real speaker with talk share, each mapped to a detected track ("V1 file.mov"); defaults by name order (Speaker 1 → V1). A **Wide shot** picker (default: last track) is used for overlaps. The autopilot finds cameras by name, so `MulticamPanel` names cameras `cam-N` and the chosen wide camera `Wide`; the mapping is logged with each Auto Cut (`Speaker 1→V1, …, wide→V3`).
2. **Mic tracks** (`MicSpeakersStep`), when there are no labels or they're wrong:
```
"Choose mic tracks"  reviewHost.getAudioTracks() → audio tracks with file clips
  rows: Mic N = track + channel (Mix / Ch 1-4) → camera. One stereo track defaults to Ch 1 / Ch 2.
"Find who talks when"  engine POST /levels per file+channel (dB, 10 per second, cached)
  └─ podcastSpeakers.placeEnvelope   each mic's clips placed on the sequence timeline
  └─ detectSpeakers   active = ≥12 dB over the mic's own floor (5th percentile) AND within 6 dB of
  │                    the loudest mic (rejects bleed, keeps crosstalk); gaps ≤0.6s bridged, turns <0.4s dropped
  └─ turnsToSegments  → TranscriptSegment[] labelled "Mic 1 (A1)" + mappings to the chosen cameras
  └─ getAutopilotOptions(micSegments, micMappings, …)   overlapping turns → wide shot, as before
```
- **Not yet verified in Premiere:** reading every audio track's clips, and whether a recording's mics are on separate tracks or on channels of one file. Thresholds are tuned on synthetic audio only.

### AI pass and Chat Edit (ROADMAP Phase 4)

```
ReviewPanel "Find retakes & repeats" / Chat Edit box
  └─ reviewModel.speechUnits(words)   sentence-sized lines: split at . ? !, segment change, or a gap > 0.8s
  └─ engineClient.aiEdit(units, {provider, apiKey, instruction, preferLastTake})
       └─ engine POST /edit → edit.ai_edit
            ├─ prompt: numbered lines "[id] mm:ss text" (+ "Editor instruction: …")
            ├─ Ollama /api/chat (JSON-schema format) or Claude (anthropic SDK, structured output)
            └─ returns removals (line-id runs → time ranges, reason, note) + keep_ids
  └─ buildCuts(words, silences, settings, aiRemovals)   AI cuts merge with adjacent pauses
```

- **Find retakes** replaces the previous AI cuts. **Chat Edit** adds its cuts on top; lines it says to keep drop any AI cut over them and switch off pause/filler cuts inside them.
- AI cuts show as cyan chips ("Retake · 3.0s · abandoned first attempt"), with their words struck through; click either to keep.
- The Anthropic key is shared with the Cold Open Finder (`localStorage` `roughcut.anthropicKey`).
- Browser demo without the engine returns a canned retake (`reviewDemo.demoAiRemovals`).
- **Not yet measured:** cut quality with a real local model. Verified so far: tests with mocked providers, the real `anthropic` SDK against a mock transport, and the full panel → engine → Ollama-protocol path against a stub server.

### Removing cuts via FCP XML (`xmlCut.ts`)

```
ProjectConverter.exportAsFinalCutProXML(active sequence) → temp folder
  └─ applyCutsToXml(xml, activeCuts, "<name> - RoughCut")
       ├─ keepRanges: cuts (seconds) → kept frame ranges + new timeline positions
       ├─ every clipitem/generatoritem on every track is split at the kept ranges and shifted
       │    in/out and pproTicksIn/Out re-timed with it, so A/V stay in sync
       ├─ start/end = -1 (clip edge inside a transition) resolved from the source length
       ├─ transitions dropped; sequence markers shifted (ones inside a cut dropped)
       ├─ each file id fully defined at its first use, bare references after
       └─ <link>s point at the matching piece; links to cut-away pieces removed
  └─ project.importFiles([cut.xml]) → find the new sequence → setActiveSequence
```

- It edits Premiere's **own** export, so tracks, effects, file references and generated media come through as they were.
- **Limits:** transitions are dropped; keyframes inside a split clip aren't re-timed; nested sequences are left as they are.
- `src/xmlCut.test.ts` covers the hand-built cases and, when the gitignored `EDIT V2 xlm for test .xml` is present, checks invariants on that real export: exact frames removed, every clip inside the new timeline, source length = timeline length, unique ids, files defined before use.
- **Not yet verified in Premiere:** `exportAsFinalCutProXML` and `importFiles` from UXP (Probe E covers import), and how Premiere relinks media on import.

- Toggled-off cuts are remembered by their start/end, so changing settings keeps your choices where the cut still exists.
- In the browser demo, `getPrimaryAudioClips()` returns `null` and the panel uses `reviewDemo.ts`.
- **Assumes the dialogue is on A1.** Multicam podcasts with one mic per track will need a track picker.
- **Not yet verified in Premiere:** A1 track-item `getInPoint()` returning source time, and `setPlayerPosition`.

---

## Architecture: how features flow

### 1. Transcript → Edit Decisions (core loop)

```
Premiere Transcript API
  └─ premiereAdapter.getTranscript()
       ├─ Strategy 1: sequence's own transcript (Transcribe Sequence)
       └─ Strategy 2: walk source clips on V1, read each clip's transcript
  └─ analyse.ts (analyseTranscript)
       └─ EditDecision[] returned to App.tsx state
```

`analyseTranscript` is pure — no Premiere calls. It takes segments + settings and emits typed decisions: `social_clip`, `chapter`, `suggested_trim`, `warning`, `strong_quote`, `camera_switch`, `social_hook`, `audiogram`.

### 2. Write-back options

| Feature | What it does in Premiere |
|---|---|
| **Create Marked Review Cut** | Clones the sequence, writes markers onto the clone |
| **Auto-Cut** | Detects cameras, clones sequence, blades camera tracks, disables non-focus clips |
| **Social Sequence** | Clones the sequence, overwrites a target track with only the hook clips |
| **Cold Open Clip** | **NEW**: Lifts a hook window, detects cameras, applies Energy Reset cuts, punch-ins, J/L edits |

All mutations go through `tx()` — the locked-access transaction wrapper (see [Critical UXP constraints](#critical-uxp-constraints) below).

### 3. Cold Open Finder → Energy Reset Assembly (AI + cutting)

The Cold Open Finder is now a **three-phase pipeline**:

#### Phase 1: Hook Finding & Shot List (✅ DONE)
```
App.tsx (findColdOpenHooks)
  └─ coldOpenFinder.findColdOpens(segments, apiKey)
       └─ POST https://api.anthropic.com/v1/messages
            system: "Podcast Cold Open Finder" + "Energy Reset Shot List" spec
       └─ ColdOpenOption[] {
            startSeconds, endSeconds, archetype, script, justification,
            shots: [
              { offsetSeconds, shot, note, punch?, jCutSeconds?, lCutSeconds? }
            ]
          }
```

Claude now returns a **shot list** for each option, following the Energy Reset pattern (≤3–4s per angle: guest_tight → host_reaction → wide → return). Optionally flags shots `punch: true` for subtle zoom-ins and `jCutSeconds` / `lCutSeconds` for J/L split edits.

#### Phase 1.5: Auto-assemble with Energy Reset Cuts
```
User clicks "Assemble this clip (with audio)"
  └─ App.tsx (assembleColdOpenFromOption)
       └─ premiereAdapter.assembleColdOpenClip(sequenceId, start, end, shots)
            ├─ Set sequence in/out to hook window
            ├─ Create subsequence(true) → carries all tracks synced
            ├─ detectSources() on the subsequence (0-based frame data)
            ├─ Convert shots → CutPoint[] via coldOpenAssembler
            ├─ bladeAndDisableInPlace() → apply camera cuts inline
            ├─ applyPunchIns() → scale keyframes on marked shots (Phase 2)
            └─ applySplitEdits() → audio leads/trails at cut points (Phase 3)
```

**Key difference from Auto-Cut**: the cold open assembly detects cameras **after** the subsequence is created, so frame data is correct (0-based, not 21:51 offset). This sidesteps the stale-handle problem that plagued the original implementation.

#### Phase 0: Runtime API Probes (⚠️ NEEDS TO RUN IN UDT)
```
User clicks "Run API Spike" (bottom of Auto-Cut section, Premiere-only)
  └─ spike-coldopen.ts (runColdOpenSpike)
       ├─ Probe A: Can we get Motion component, find Scale, add keyframes?
       ├─ Probe B: Can we get audio track item and set in/out?
       └─ Probe C: Does insertMogrtFromPath exist at runtime?
  └─ Results show inline (green/red per probe)
```

Phase 0 must run **once** on a real multi-cam sequence in UDT to gate Phases 2–4. If Probe A fails, punch-ins are silently skipped (but the flat cut still lands). If Probe B fails, J/L edits are skipped. Probe C gates Phase 4 (kinetic typography — not yet built).

#### Phase 2: Digital Punch-Ins (gated by Probe A)
When Claude marks a shot `punch: true`, `applyPunchIns()` finds the corresponding video clip on the correct camera track, walks `Motion → Scale`, enables time-varying, and places two keyframes: **100% at clip start → 103% at clip end**. Subtle creep-in zoom that draws the eye. Silently skipped if Motion component or Scale param is inaccessible.

#### Phase 3: J/L Split Edits (gated by Probe B)
When Claude marks the opening shot `jCutSeconds: 1.5`, the audio in-point shifts earlier so sound leads video. When the closing shot has `lCutSeconds: 1.0`, audio trails into black. Silently skipped if audio track access fails.

#### Fallback: Always returns a usable clip
If any phase (camera cuts, punch-ins, J/L edits) throws, the flat clip with synced audio is still returned. The error details appear in the success message (e.g., "SYNC1 - Cold Open — flat (multicam switch skipped: …)").

---

## Cold Open Finder: system prompt spec

The system prompt in `coldOpenFinder.ts` implements the client's exact evaluation criteria:

- **3-Second Rule** — first sentence must contain a high-impact hook word
- **Context Independence** — must make sense to a stranger with zero context
- **25-Second Cutoff** — narrative arc must reach a cliffhanger between 20–30s
- **Visual Potential** — must imply dynamic delivery, not flat exposition
- **Banned Elements** — host introductions, unexplained jargon, flat endings, >75 words

**NEW**: Claude also returns a **shot list** for internal multi-cam cutting, per the Energy Reset spec:
- No single angle > 3–4 seconds
- Pattern: guest_tight → host_reaction → wide → guest_tight → …
- Shots marked `punch: true` for emphasis beats (scale zoom)
- Optionally `jCutSeconds` and `lCutSeconds` for audio overlap

JSON output shape:
```json
{
  "options": [{
    "startSeconds": number,
    "endSeconds": number,
    "archetype": string,
    "script": string,
    "justification": string,
    "shots": [{
      "offsetSeconds": number,
      "shot": "guest_tight|host_reaction|wide",
      "note": string,
      "punch": boolean,
      "jCutSeconds": number,
      "lCutSeconds": number
    }]
  }]
}
```

---

## New files (Phase 0–3)

### `coldOpenAssembler.ts`
Pure logic: converts a `ColdOpenShot[]` into a `CutPoint[]` for the blade+disable engine.
- `shotToCamera(shot, sources)` — maps shot type to camera number
- `shotsToEnergyResetCuts(shots, windowSeconds, sources, frameRate)` — converts offsets to frames, enforces 3s min, clamps to window
- 14 unit tests in `coldOpenAssembler.test.ts`

### `spike-coldopen.ts`
Throwaway probe suite (delete after Phase 0 results are confirmed):
- Clones the active sequence
- Tests `VideoComponentChain → ComponentParam → createKeyframe` (scale)
- Tests audio track item in/out access (J/L cuts)
- Tests `insertMogrtFromPath` existence (MOGRT)
- Returns `Phase0Results { probeA, probeB, probeC }` with `{ ok, detail }`

### `COLD_OPEN_DYNAMIC_PLAN.md`
Full phased implementation spec covering:
- What each phase does
- Which APIs it needs (and the fallback if they fail)
- Risk mitigations
- Test strategy

---

## Premiere API internals

### `bladeAndDisableInPlace(project, seqId, intervals, sources, fr)` (NEW)
The core blade+disable engine from `applyCutMap`, but operating **in place** on a subsequence (no clone). Each interval shows only its focus camera; others are bladed away and disabled.
- Saves/restores source bin in/out points (so Source Monitor stays clean)
- Batches disables in groups of 20 to avoid Premiere crashes
- All-in-place, zero clones

### `applyPunchIns(project, seqId, shots, cuts, sources, fr, frameRate)` (NEW)
Marks 1–2 shots per clip with `punch: true`. For each:
- Finds the video clip on the correct camera track at the matching cut
- Walks the `Motion` component → `Scale` param
- Creates two keyframes: 100% → 103% (subtle zoom)
- Non-fatal: throws caught silently if Motion not accessible

### `applySplitEdits(project, seqId, shots, cuts, fr, frameRate)` (NEW)
For shots with `jCutSeconds > 0` or `lCutSeconds > 0`:
- Finds the A1 (primary audio) clip matching the cut
- J-cut: shifts audio in-point earlier (audio leads video)
- L-cut: shifts audio out-point later (audio trails into next angle)
- Non-fatal: throws caught silently if audio access fails

---

## Critical UXP constraints

### `tx()` — every Premiere mutation needs this

```typescript
// premiereAdapter.ts
private tx(project, build, label): boolean {
  let ok = false
  project.lockedAccess(() => {
    ok = project.executeTransaction(build, label)
  })
  return ok
}
```

Every call to `executeTransaction` **must** be wrapped in `lockedAccess`. Without it, any object referenced inside the transaction reports `"script object is no longer valid"`.

### Stale handle gotcha (BANANAS E4)

Premiere invalidates project-item handles after any mutating transaction. The pattern:

```typescript
// WRONG — handle from before the tx is stale
let { project, sequence } = await this.context()
this.tx(project, ...)          // tx stales sequence
await doSomething(sequence)    // crashes: "script object no longer valid"

// RIGHT — re-fetch after every tx
let { project, sequence } = await this.context()
this.tx(project, ...)
;({ project, sequence } = await this.context())  // re-fetch
await doSomething(sequence)
```

### `hasTranscript` doesn't exist at runtime

The `@adobe/premierepro` type definitions are ahead of the runtime. `Transcript.hasTranscript()` throws at runtime. Call `Transcript.exportToJSON(clipItem)` directly and treat an empty/throw result as "no transcript".

### External links need the shell

`<a href>` does nothing in UXP. To open a URL:

```typescript
const uxp = getRuntimeRequire()?.('uxp')
uxp?.shell?.openExternal(url)
```

This requires `"launchProcess": { "schemes": ["https"] }` in `manifest.json`. First use shows a one-time OS permission dialog.

### Network access needs a manifest entry

The Claude API call requires:

```json
"requiredPermissions": {
  "network": { "domains": ["https://api.anthropic.com"] },
  "launchProcess": { "schemes": ["https"] }
}
```

Manifest changes need **UDT Unload + Load** — not just Reload.

### No `@anthropic-ai/sdk` — raw `fetch` only

UXP is browser-like. The Anthropic Node SDK won't work. The fetch needs:

```typescript
headers: {
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  'content-type': 'application/json',
}
```

### `<button>` rendering

UXP paints native chrome over `<button>` backgrounds. All clickable elements in this codebase are rendered as `<span role="button">` via the `Press` component in `App.tsx`.

### Large transactions crash Premiere

Marker write-back batches in groups of 20. Camera cuts batch disables in groups of 20:

```typescript
const BATCH = 20
for (let i = 0; i < targets.length; i += BATCH) {
  const chunk = targets.slice(i, i + BATCH)
  this.tx(project, (c) => {
    for (const it of chunk) c.addAction(it.createSetDisabledAction(true))
  }, label)
}
```

### Keyframe API note

`ComponentParam.createKeyframe(value)` creates a keyframe with the given value. The **time** is set via `keyframe.position = TickTime` (not `.time`). The keyframe is then added to an action via `createAddKeyframeAction(keyframe)`:

```typescript
const kf = scaleParam.createKeyframe(103)
kf.position = clipEndTick
this.tx(project, (c) => {
  c.addAction(scaleParam.createSetTimeVaryingAction(true))
  c.addAction(scaleParam.createAddKeyframeAction(kf))
}, 'Add keyframe')
```

---

## Auto-Cut: how it works

1. **Detect Cameras** (`detectSources`) — reads video tracks, classifies each as `camera | skip | end`, returns `DetectedSources` (sources, targetTrackIndex, totalFrames, frameRate, fingerprint).

2. **Generate cut map** — `autopilot.generateCutMapForProfile()` maps transcript speaker turns to camera indices. Falls back to cadence-based rotation (`rotateCutMap`) when the transcript has no speaker diarization (everything is `"Unknown"`).

3. **Apply** (`applyCutMap`) — verifies the fingerprint hasn't changed since detection, clones the sequence, blades each camera track by overwriting with exact in/out frames, disables non-focus segments per interval. Restores source in/out points in a `finally` block so the Source Monitor is left clean.

---

## Diarization fallback

"Transcribe Sequence" often produces no speaker diarization — every segment is `"Unknown"`. The auto-cut detects this (≤1 distinct camera after mapping) and switches to `rotateCutMap()`, cycling through available cameras at the profile's cadence. This is expected degraded-mode behaviour, not a bug. Three profiles are available: Balanced (2.5s min shot), Dynamic (1.5s), Conservative (4.0s).

---

## Recent commits (as of handover)

```
807bc15  Phase 0 spike button + Phase 2 punch-ins + Phase 3 J/L split edits
43c34a1  Fix cold open camera cuts: detect on subsequence + cut in place
be913f6  Auto-detect cameras on cold open assemble — remove manual step
21e7564  Add thinking animation to cold open finder while Claude is working
c9b63ea  Show 'Detect Cameras first' hint when shot plan exists but no sources
banans#3 (PR)  Energy Reset cold open: Claude shot list + multi-cam internal cuts
```

---

## What needs testing

**Phase 0 spike** must run in UDT before Phases 2–3 are considered stable:
1. Load the plugin in Premiere UDT on a real multi-cam sequence (V1/V2/V3)
2. Scroll to bottom of Auto-Cut section
3. Click **Run API Spike**
4. Check the results inline:
   - ✓ Scale keyframing (Probe A) — gates punch-ins
   - ✓ Audio track access (Probe B) — gates J/L edits
   - ✓ MOGRT (Probe C) — gates Phase 4 typography
   - ✓ Ripple delete (Probe D) — gates real silence/filler cutting (ROADMAP Phase 3a). Needs **2+ clips on V1**.
   - ✓ FCP XML import (Probe E) — fallback cutting path (ROADMAP Phase 3b). Leaves a "RoughCut XML Probe" sequence to delete.
   - ✓ Media file path (Probe F) — the local engine needs source file paths (ROADMAP Phase 1)

If any probe fails, the corresponding feature silently degrades (but the flat clip + cuts still land). Report the green/red results so Phases 2–3 can be marked safe or scheduled for rework.

---

## Known issues / next steps

- **Speaker → track mapping is manual** (sensible defaults by name order; nothing reads faces or clip names yet).
- **No speaker labels** — when Premiere's transcript has none, Podcast Mode's mic fallback replaces the old camera rotation (rotation still happens if neither is used).
- **Eval harness is offline only** — `src/eval/` scores hook options against FCP XML reference edits, but there is no CI gate on eval quality yet.
- **Multicam clips not supported** — `detectSources` will error if the sequence contains a Multicam Source Clip rather than individual camera tracks on separate video tracks.
- **Phase 0 spike results** — Run the API probes in UDT to confirm scale keyframing, audio access, and MOGRT work before declaring Phases 2–4 production-ready.
- **Phase 4 (kinetic typography)** — Deferred. Needs a designed `.mogrt` template + Probe C confirmation. Separate PR recommended.
