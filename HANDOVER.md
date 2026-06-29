# RoughCut – Developer Handover

_Last updated: 2026-06-29_

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
  App.tsx                  Single-component UI (all state lives here)
  App.css / index.css      Styles
  types.ts                 Shared interfaces (TranscriptSegment, EditDecision, PremiereAdapter, …)
  premiereAdapter.ts       UxpPremiereAdapter — all Premiere API calls
  mockPremiere.ts          MockPremiereAdapter — browser/demo mode
  hostRuntime.ts           getRuntimeRequire() / isPremiereHost() — runtime detection
  analyse.ts               Pure transcript → EditDecision engine
  autopilot.ts             Multi-cam cut map generator + evaluator
  cutEngine.ts             Timeline interval maths
  coldOpenFinder.ts        Claude API integration (hook finding)
  transcriptParse.ts       CSV / SRT / JSON file parser
  eval/                    Evaluation harness (FCP XML reference, fixtures, scorer)
public/
  manifest.json            UXP manifest — permissions live here
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
| **Auto-Cut** | Clones the sequence, blades camera tracks, disables non-focus clips |
| **Social Sequence** | Clones the sequence, overwrites a target track with only the hook clips |
| **Cold Open Clip** | Sets sequence in/out to hook range, calls `createSubsequence(true)` |

All mutations go through `tx()` — the locked-access transaction wrapper (see [Critical UXP constraints](#critical-uxp-constraints) below).

### 3. Cold Open Finder (AI)

`src/coldOpenFinder.ts` sends the timestamped transcript to `claude-opus-4-8` and gets back exactly 3 ranked hook options.

```
App.tsx (findColdOpenHooks)
  └─ coldOpenFinder.findColdOpens(segments, apiKey)
       └─ POST https://api.anthropic.com/v1/messages
            headers: anthropic-dangerous-direct-browser-access: true
            system: client's "Podcast Cold Open Finder" evaluation spec
       └─ ColdOpenOption[] { startSeconds, endSeconds, archetype, script, justification }
  └─ User picks one → assembleColdOpenFromOption(option)
       └─ premiereAdapter.assembleColdOpenClip(sequenceId, start, end)
            └─ createSubsequence(true)  ← carries ALL tracks with synced audio
```

The API key is stored in `localStorage` under `roughcut.anthropicKey`. UXP's `localStorage` persists across panel close/reopen and Premiere restarts — the user only needs to enter it once.

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

Marker write-back batches in groups of 20:

```typescript
const BATCH = 20
for (let i = 0; i < decisions.length; i += BATCH) {
  this.tx(project, (compound) => { /* max 20 addAction calls */ }, label)
}
```

---

## Auto-Cut: how it works

1. **Detect Cameras** (`detectSources`) — reads video tracks, classifies each as `camera | skip | end`, returns `DetectedSources` (sources, targetTrackIndex, totalFrames, frameRate, fingerprint).

2. **Generate cut map** — `autopilot.generateCutMapForProfile()` maps transcript speaker turns to camera indices. Falls back to cadence-based rotation (`rotateCutMap`) when the transcript has no speaker diarization (everything is `"Unknown"`).

3. **Apply** (`applyCutMap`) — verifies the fingerprint hasn't changed since detection, clones the sequence, blades each camera track by overwriting with exact in/out frames, disables non-focus segments per interval. Restores source in/out points in a `finally` block so the Source Monitor is left clean.

---

## Cold Open Finder: system prompt spec

The system prompt in `coldOpenFinder.ts` implements the client's exact evaluation criteria:

- **3-Second Rule** — first sentence must contain a high-impact hook word
- **Context Independence** — must make sense to a stranger with zero context
- **25-Second Cutoff** — narrative arc must reach a cliffhanger between 20–30s
- **Visual Potential** — must imply dynamic delivery, not flat exposition
- **Banned Elements** — host introductions, unexplained jargon, flat endings, >75 words

Claude returns JSON: `{ options: [{ startSeconds, endSeconds, archetype, script, justification }] }`. The `extractOptions()` helper strips markdown fences if Claude adds them despite instructions.

---

## Diarization fallback

"Transcribe Sequence" often produces no speaker diarization — every segment is `"Unknown"`. The auto-cut detects this (≤1 distinct camera after mapping) and switches to `rotateCutMap()`, cycling through available cameras at the profile's cadence. This is expected degraded-mode behaviour, not a bug. Three profiles are available: Balanced (2.5s min shot), Dynamic (1.5s), Conservative (4.0s).

---

## Recent commits (as of handover)

```
bc22656  Fix dead API-key link: add launchProcess manifest permission
46f6c8d  Add console.anthropic.com link above API key input
2970639  Cold Open Finder: Claude API hook selection + clean audio assembly
ab68b5c  Generate real camera switches via rotation fallback + faster apply
f1a03f2  Auto Cut: camera-switch by disabling non-focus clips on all tracks
cb4b455  Wrap every transaction in lockedAccess (fixes [clone sequence] error)
faaebca  Fix [clone sequence] stale handle: no await between fetch and createCloneAction
394415c  Re-fetch every live handle per cut + add phase instrumentation
```

---

## Known issues / next steps

- **Speaker mapping is manual** — the user must assign Host/Guest → Camera 1/2. Auto-detection from clip names would be a quality-of-life improvement.
- **No diarization in most projects** — Premiere's "Transcribe Sequence" rarely outputs speaker IDs; the rotation fallback fires for most real projects.
- **Eval harness is offline only** — `src/eval/` scores hook options against FCP XML reference edits, but there is no CI gate on eval quality yet.
- **Multicam clips not supported** — `detectSources` will error if the sequence contains a Multicam Source Clip rather than individual camera tracks on separate video tracks.
