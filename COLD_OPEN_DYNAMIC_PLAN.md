# Plan: Dynamic Cold Open ("Energy Reset" auto-edit)

_Drafted: 2026-06-29_

## Goal

Today the Cold Open Finder picks the best ~30s window and lifts it as one
contiguous subsequence (`createSubsequence(true)`). This plan turns that flat
window into a **cut, paced, retention-optimised cold open** — implementing the
client's "Energy Reset" editing spec: internal multi-cam cuts, digital
punch-ins, split edits, and kinetic typography.

## What exists we can build on

| Asset | Reuse |
|---|---|
| `coldOpenFinder.ts` | Already returns the chosen window + archetype from Claude. Extend the prompt to also return an internal **shot list**. |
| `applyCutMap` / `cutEngine.ts` | Proven multi-cam camera-switch engine (blade + disable). The Energy Reset cutting reuses this directly. |
| `detectSources` | Already maps cameras → tracks with frame-accurate in/out. |
| `tx()` + stale-handle re-fetch | All Premiere mutations already go through the locked, re-fetch-safe path. |
| `autopilot.resolveCameraNum` | Speaker → camera resolution for "Host reaction" / "Guest single". |

## Feasibility check (done)

The `@adobe/premierepro` type defs expose `ComponentParam` / `createKeyframe`
(scale keyframing), `Mogrt` (graphics import), `getAudioTrack` /
`AudioClipTrackItem` (split edits), and `Caption`.

⚠️ **The type defs run ahead of the runtime** (the `hasTranscript` lesson — it
was typed but threw at runtime). So every API below that isn't already used by
`applyCutMap` must be **probed on the live object in a spike before we build on
it**. This is why the plan is phased by confidence, not feature size.

---

## Phased plan

### Phase 0 — API spike (gate the rest)  · ~½ day · low risk, high value

Write a throwaway `spike-coldopen.ts` (mirrors the existing `spike-autocut.ts`)
that, on a real sequence, probes the live runtime for:

1. **Scale keyframing** — can we get a clip's Motion component, set Scale, and
   add two keyframes? (`getComponent` → `ComponentParam` → `createKeyframe`)
2. **MOGRT import** — does `importMogrt` exist and place a text graphic?
3. **Audio track item access** — can we read/trim the linked audio item
   independently for J/L cuts?

Output: a one-page findings note. **Each green light unlocks its phase below;
each red light drops that phase to "marker-only" fallback** (we write a marker
telling the editor where to add the punch-in / text by hand).

---

### Phase 1 — Energy Reset cutting  · HIGH confidence · the core win

Reuses `applyCutMap` infrastructure end to end. No new Premiere primitives.

1. **Extend the Claude response.** Add an optional `shots[]` to `ColdOpenOption`:
   ```ts
   shots: { atSeconds: number; shot: 'guest_tight' | 'host_reaction' | 'wide';
            note: string }[]
   ```
   Update the system prompt to emit the pattern from the spec (≤3–4s per angle:
   guest tight → host reaction → wide → return), anchored to real speaker turns.
2. **Translate shots → CutPoint[].** Map each shot's `shot`/speaker to a camera
   via `resolveCameraNum`, convert `atSeconds` to frames relative to the window.
3. **Assemble.** Replace the flat `createSubsequence` path for the chosen option
   with: subsequence the window (carries audio synced) → run the existing
   camera-switch logic (`buildCutIntervals` + blade/disable) across the window.
4. **Enforce the 3-second rule** in code as a guard: no interval longer than the
   profile max during the hook; auto-insert a reaction/wide cut if Claude's
   shot list leaves a gap.

Deliverable: a cold open that actually *cuts* between angles. This alone
satisfies the bulk of the retention spec.

---

### Phase 2 — Digital punch-ins  · MEDIUM · spike-gated (Phase 0 #1)

If keyframing is green:
- On emphasis beats Claude flags (`punch: true` on a shot), set the clip's
  Motion → Scale to 110–115% on the cut (step), or animate 100→103% across a
  shot for the micro-zoom.
- Helper `applyScaleKeyframes(clip, fromPct, toPct, startTick, endTick)`.

If red: write a `camera_switch`-style marker "Punch-in 115% here" so the editor
does it manually. No blocked feature, just degraded automation.

---

### Phase 3 — J/L split edits  · MEDIUM · spike-gated (Phase 0 #3)

If audio-item access is green:
- After the video cut list is placed, offset the **audio** in-point of the next
  clip ~1–1.5s earlier (J-cut: audio leads) or hold video ~1s past audio
  (L-cut) at the cliffhanger.
- Keep it to the two highest-value edits (opening J-cut, closing L-cut) — the
  spec warns against over-applying.

---

### Phase 4 — Kinetic typography  · LOW confidence · spike-gated (Phase 0 #2)

Needs a designed `.mogrt` template shipped with the plugin **and** runtime
`importMogrt` support.
- Claude returns the 1–3 word anchor phrases + timestamps (core thesis only,
  not full subtitles).
- Import the MOGRT per phrase, set its text + in/out.

If MOGRT import isn't supported at runtime, fall back to Premiere's
caption/`Caption` API or markers. **Recommend deferring this to its own follow-up
PR regardless** — it's the lowest-confidence, highest-asset-dependency piece.

---

### Out of scope: B-roll interruption

The plugin has no library of archival footage/photos to insert and no reliable
way to source them. Leave this as an editor-manual step (optionally: drop a
marker where Claude thinks B-roll would land).

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Runtime lacks keyframe/MOGRT APIs despite type defs | Phase 0 spike gates each phase; every phase has a marker-only fallback |
| Claude shot lists drift out of the window or reference missing cameras | `cutEngine` already validates coverage and rejects out-of-range intervals |
| Dense cuts stale handles | Reuse the proven `tx()` + per-cut re-fetch pattern from `applyCutMap` |
| Over-editing (spec warns against it) | Hard caps in code: max cuts/min, ≤2 split edits, typography on thesis only |

## Test strategy

- Pure logic (shots → CutPoint[], 3-second-rule guard, punch-in keyframe math)
  gets Vitest unit tests like `autopilot.test.ts` / `cutEngine.test.ts`.
- Premiere-side assembly verified manually in UDT on a real multi-cam sequence
  (no automated harness for the host API).

## Recommended sequencing

**Ship Phase 0 + Phase 1 as the first PR** (the real retention win, all
high-confidence). Then Phases 2–3 as a second PR once the spike confirms the
APIs. Phase 4 (typography) as a separate follow-up.
