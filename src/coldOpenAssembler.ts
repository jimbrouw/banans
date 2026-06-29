// coldOpenAssembler.ts — Pure Energy Reset cut-map logic for the cold open.
//
// Translates a Claude shot list (ColdOpenShot[]) into a CutPoint[] that the
// Premiere adapter applies to the cold-open subsequence. No Premiere imports —
// fully unit-testable. The adapter (premiereAdapter.assembleColdOpenClip) detects
// cameras on the subsequence and feeds those sources in here.

import type { ColdOpenShot } from './coldOpenFinder'
import type { CutPoint, DetectedSources } from './cutEngine'
import { resolveCameraNum } from './autopilot'

/** The minimum per-angle dwell time in seconds (the 3-second rule). */
const MIN_SHOT_SECONDS = 3

/**
 * Translate a shot type string to a camera number using the detected sources.
 *
 * Mapping:
 *   guest_tight   → Camera 1 (typically the guest's close single, V1)
 *   host_reaction → Camera 2 (typically the host's close single, V2)
 *   wide          → the source whose name contains "wide", else last camera
 */
export function shotToCamera(
  shot: ColdOpenShot['shot'],
  sources: DetectedSources['sources'],
): number {
  const sourcesList = sources.map((s) => ({ camera: s.camera, name: s.name }))
  switch (shot) {
    case 'guest_tight':
      return sources[0]?.camera ?? 1
    case 'host_reaction':
      return sources[1]?.camera ?? 2
    case 'wide':
      return resolveCameraNum('wide', sourcesList)
  }
}

/**
 * Convert an Energy Reset shot list into a CutPoint array for the given
 * hook window. Offsets are relative to the window start (0 = windowStart).
 *
 * Enforces the 3-second minimum: any shot that would create an interval
 * shorter than MIN_SHOT_SECONDS is dropped. The first shot is always kept
 * (it starts at 0) and forced to camera 1 if not already set.
 *
 * @param shots         Shot list from ColdOpenOption (already sorted by offset).
 * @param windowSeconds Total duration of the hook window in seconds.
 * @param sources       Detected camera sources (for camera resolution).
 * @param frameRate     Sequence frame rate.
 */
export function shotsToEnergyResetCuts(
  shots: ColdOpenShot[],
  windowSeconds: number,
  sources: DetectedSources['sources'],
  frameRate: number,
): CutPoint[] {
  if (!shots.length) return [{ frame: 0, camera: shotToCamera('guest_tight', sources) }]

  const toFrame = (sec: number) => Math.max(0, Math.round(sec * frameRate))

  const cuts: CutPoint[] = []
  let lastFrame = -1

  for (const shot of shots) {
    // Clamp to window bounds.
    if (shot.offsetSeconds >= windowSeconds) break

    const frame = toFrame(shot.offsetSeconds)
    const camera = shotToCamera(shot.shot, sources)

    // Skip if this cut would make the previous interval too short.
    if (lastFrame >= 0 && (frame - lastFrame) / frameRate < MIN_SHOT_SECONDS) continue

    cuts.push({ frame, camera })
    lastFrame = frame
  }

  // Always start at frame 0.
  if (!cuts.length || cuts[0].frame !== 0) {
    const firstCamera = shots[0] ? shotToCamera(shots[0].shot, sources) : shotToCamera('guest_tight', sources)
    cuts.unshift({ frame: 0, camera: firstCamera })
  }

  return cuts
}
