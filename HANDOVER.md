# RoughCut v2 – Session Handover

**Date:** 2026-06-22  
**Branch:** `feature/roughcut-v2` (pushed to origin)

---

## What Was Done

We implemented the core features for **RoughCut v2**: a safe, robust multi-cam auto-cutting engine and an intelligent transcript-driven autopilot dashboard.

### 1. Multi-Cam Auto-Cut Engine (Phase 1)
- **Automatic Camera Track Detection**: Scans sequence video tracks, mapping and verifying offsets, frame rates, and clip limits.
- **Dynamic Target Track Allocation**: Automatically identifies a safe empty track above current clips to write output sequences without destroying B-roll or titles.
- **Safe Overwrite/Insert Transactions**: Clones the active sequence and overwrites/inserts angles onto the target track.
- **Platform-Safe Restoration**: Ensures original source clips' in/out points are fully restored in the Source Monitor, even if transactions fail midway.

### 2. Transcript-Driven Autopilot (Phase 2)
- **Autopilot Profiles**: Created three edit presets:
  - **Balanced (Recommended)**: Switches on turns (min shot 2.5s), Wide on overlap.
  - **Dynamic Cut**: Quick cutting style (min shot 1.5s), shifts camera on short turns.
  - **Conservative Dialogue**: Restricts cuts to sustained turns (min shot 4.0s).
- **Rule-Based Evaluations**: Automatically runs four checks (shot duration, frequency, overlap wide usage, stability) and ranks options with dynamic scorecards.

### 3. Cold Open & Social Hook Assembly (Phase 3)
- **Inquisitive Hook Scanner**: Automatically flags segment questions, hook phrases, and keywords (e.g. *secret*, *mistake*, *proven*).
- **Auto-Assembly Sequence**: Adds an "Assemble YouTube Cold Open" feature that copies selected hook clips sequentially back-to-back starting at 0.0s on the cloned timeline.

---

## New & Modified Files

### Core Modules
- **`src/cutEngine.ts`** / **`src/cutEngine.test.ts`**: Pure multi-cam cut math (42 unit tests).
- **`src/autopilot.ts`** / **`src/autopilot.test.ts`**: Presets, evaluations, scoring, and ranking (6 unit tests).
- **`src/analyse.ts`** / **`src/analyse.test.ts`**: Hook patterns and `'social_hook'` classification triggers.
- **`src/premiereAdapter.ts`**: UXP Premiere Pro adapter implementation for multi-cam detection, auto-cuts, and sequence assembly.
- **`src/mockPremiere.ts`**: Web demo simulator stubs.
- **`src/types.ts`**: Extended interfaces for v2 features.
- **`src/App.tsx`**: Updated with the Autopilot profiles selector, scorecard checklist, and assembly action controls.
- **`src/spike-autocut.ts`**: Throwaway spike tests verifying track auto-creation and audio suppression.

---

## Verification & Build

```bash
cd "/Users/standard/Developer/pro pod"
npm run build:uxp   # Generates plugin-dist/ for UXP Developer Tool
npx vitest run      # 90 tests, all passing
```

All unit tests pass cleanly, and the bundle compiles with no TypeScript errors.
