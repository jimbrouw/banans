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
  App.tsx                      Shell: shared state (sequence, settings, transcript, decisions)
  panels/                      One component per panel section; feature-local state lives here
    SequencePanel.tsx          Active sequence + speaker mapping
    AnalysisPanel.tsx          Analysis toggles/settings + Analyse button
    ResultsPanel.tsx           Marker list, filters, export, Create Marked Review Cut
    ColdOpenPanel.tsx          Cold Open Finder (API key, options, assemble)
    AutoCutPanel.tsx           Detect cameras, autopilot options, apply
    SpikePanel.tsx             Phase 0 API probe runner (Premiere only)
    EngineStatus.tsx           Header pill: is the local engine reachable?
    ReviewPanel.tsx            Clean-up review: transcript, pause/filler cuts, toggle, marked cut
  reviewModel.ts               Pure: source→sequence time mapping, cut building/merging, summary
  reviewHost.ts                Premiere reads for review: A1 clips + media paths, set playhead
  reviewDemo.ts                Canned engine output for the browser demo
  xmlCut.ts                    Pure: remove time ranges from a Premiere FCP XML export
  xmlCutHost.ts                Premiere glue: export XML → xmlCut → import → open new sequence
  engineClient.ts              Typed fetch client for the local engine (127.0.0.1:7317)
  ui.tsx                       Shared components: Press, Toggle
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

## Local engine (`engine/`)

UXP panels can't spawn processes, so anything that needs ffmpeg or an ML model runs in a separate local Python service the panel calls over `http://127.0.0.1:7317`.

```
Panel (UXP) ── engineClient.ts ──fetch──▶ roughcut-engine (FastAPI, uv)
                                            ├─ POST /silences   ffmpeg silencedetect
                                            └─ POST /transcribe mlx-whisper, word timestamps, fillers kept
```

- Start it: `cd engine && uv run roughcut-engine`. The header shows **Engine** (green) or **Engine off**.
- The panel passes the clip's media **path** (Probe F checks we can read it); the engine reads the file directly.
- `engineHealth()` returns `null` when the engine is down, and every feature must keep working on Premiere's own transcript in that case.
- Manifest allows `http://127.0.0.1:7317` (needs UDT Unload → Load). **Not yet verified in UXP**: whether UXP's network permission accepts plain http to localhost.
- The **Clean-up review** panel (ROADMAP Phase 2) is the first consumer, described below.

### Clean-up review flow

```
ReviewPanel "Transcribe & find pauses"
  └─ reviewHost.getPrimaryAudioClips()   A1 clips: media path, sequence start/end, source in-point
  └─ per unique media file: engine /transcribe + /silences (min 0.3s, filtered locally)
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

- **Speaker mapping is manual** — the user must assign Host/Guest → Camera 1/2. Auto-detection from clip names would be a quality-of-life improvement.
- **No diarization in most projects** — Premiere's "Transcribe Sequence" rarely outputs speaker IDs; the rotation fallback fires for most real projects.
- **Eval harness is offline only** — `src/eval/` scores hook options against FCP XML reference edits, but there is no CI gate on eval quality yet.
- **Multicam clips not supported** — `detectSources` will error if the sequence contains a Multicam Source Clip rather than individual camera tracks on separate video tracks.
- **Phase 0 spike results** — Run the API probes in UDT to confirm scale keyframing, audio access, and MOGRT work before declaring Phases 2–4 production-ready.
- **Phase 4 (kinetic typography)** — Deferred. Needs a designed `.mogrt` template + Probe C confirmation. Separate PR recommended.
