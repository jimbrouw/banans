// cutEngine.ts — Pure multi-cam cut engine logic.
// Zero Premiere imports. Every function independently testable.

// ── Types ─────────────────────────────────────────────────────────────────────

/** Stable metadata for a detected camera. No host objects (ProjectItem, etc.). */
export interface CameraSource {
  /** Video track index (0-based) in the source sequence. */
  vIndex: number
  /** 1-based camera number in detection order. */
  camera: number
  /** Display name from the project item. */
  name: string
  /** Absolute path to the media file (for verification, not lookup). */
  mediaPath: string
  /** Timeline start frame of the placed clip. */
  clipStartFrame: number
  /** Media in-point frame of the placed clip. */
  clipInFrame: number
  /** Media out-point frame of the placed clip (exclusive). */
  clipOutFrame: number
}

export interface DetectedSources {
  /** Sequence GUID at detection time. */
  sequenceId: string
  /**
   * Canonical snapshot of the full detection state. A plain JSON string.
   * applyCutMap re-reads the sequence, rebuilds the snapshot, and rejects
   * if it differs — catching any timeline edit after detection.
   */
  fingerprint: string
  sources: CameraSource[]
  /** Video track index for the output assembly. */
  targetTrackIndex: number
  /** Total timeline length in frames. */
  totalFrames: number
  /** Sequence frame rate value (e.g. 29.97). */
  frameRate: number
}

export interface CutPoint {
  /** Timeline frame where this cut begins. */
  frame: number
  /** 1-based camera number. */
  camera: number
}

export interface CutInterval {
  /** Timeline start frame (inclusive). */
  startFrame: number
  /** Timeline end frame (exclusive). */
  endFrame: number
  /** 1-based camera number. */
  camera: number
  /** Media source in-point for this interval (frames). */
  sourceInFrame: number
  /** Media source out-point for this interval (frames, exclusive). */
  sourceOutFrame: number
}

// ── Track classification ──────────────────────────────────────────────────────

export type TrackClassification = 'camera' | 'skip' | 'end'

/**
 * Classify a video track during source detection.
 *
 * - Empty tracks are skipped (harmless gap in the stack).
 * - Single-clip adjustment layers are skipped.
 * - Single-clip nested sequences terminate the camera run.
 * - Single-clip media clips are cameras.
 * - Multi-clip tracks terminate the camera run.
 */
export function classifyTrackForDetection(
  clipCount: number,
  isSequence: boolean,
  isAdjustmentLayer: boolean,
): TrackClassification {
  if (clipCount === 0) return 'skip'
  if (clipCount === 1) {
    if (isAdjustmentLayer) return 'skip'
    if (isSequence) return 'end'
    return 'camera'
  }
  return 'end'
}

// ── Output track selection ────────────────────────────────────────────────────

/**
 * Select the output track for the assembly.
 *
 * Scans upward from one above the highest camera track, looking for
 * the first verified-empty track. If none exists within the current
 * track count, returns videoTrackCount (auto-created on first insert).
 *
 * @param sources       Detected camera sources.
 * @param videoTrackCount  Total video track count in the sequence.
 * @param getTrackItemCount  Returns the CLIP item count for a given track index.
 */
export function selectOutputTrack(
  sources: CameraSource[],
  videoTrackCount: number,
  getTrackItemCount: (vIndex: number) => number,
): number {
  if (sources.length === 0) return videoTrackCount

  const firstCandidate = Math.max(...sources.map(s => s.vIndex)) + 1
  for (let v = firstCandidate; v < videoTrackCount; v++) {
    if (getTrackItemCount(v) === 0) return v
  }
  // No empty track found — return one past the end (auto-created).
  return videoTrackCount
}

// ── Detection validation ──────────────────────────────────────────────────────

/**
 * Validate that the detected sources form a usable multi-cam layout.
 * Throws with an actionable error message on failure.
 */
export function validateDetectedSources(
  sources: CameraSource[],
  targetTrackIndex: number,
): void {
  if (sources.length < 2) {
    throw new Error(
      `Need at least 2 camera tracks (found ${sources.length}). ` +
      `Stack one camera per video track starting from V1.`,
    )
  }

  const cameraTrackIndices = new Set(sources.map(s => s.vIndex))
  if (cameraTrackIndices.has(targetTrackIndex)) {
    const conflicting = sources.find(s => s.vIndex === targetTrackIndex)!
    throw new Error(
      `Target track V${targetTrackIndex + 1} is occupied by camera ${conflicting.camera} ("${conflicting.name}").`,
    )
  }
}

// ── Detection fingerprint ─────────────────────────────────────────────────────

/**
 * Build a canonical snapshot string of the full detection state.
 * Plain JSON — no custom hashing.
 */
export function buildDetectionFingerprint(
  sequenceId: string,
  frameRate: number,
  totalFrames: number,
  targetTrackIndex: number,
  targetTrackItemCount: number,
  sources: CameraSource[],
): string {
  return JSON.stringify({
    sequenceId,
    frameRate,
    totalFrames,
    targetTrackIndex,
    targetTrackItemCount,
    sources: sources.map(s => ({
      vIndex: s.vIndex,
      mediaPath: s.mediaPath,
      clipStartFrame: s.clipStartFrame,
      clipInFrame: s.clipInFrame,
      clipOutFrame: s.clipOutFrame,
    })),
  })
}

// ── Cut map normalization ─────────────────────────────────────────────────────

/**
 * Normalize, sort, deduplicate, and validate a cut map.
 *
 * @param cuts       Raw cut points.
 * @param endFrame   Exclusive end frame of the application range.
 * @param cameraCount  Number of detected cameras.
 * @returns Cleaned, sorted CutPoint array. Throws on violation.
 */
export function normalizeCutMap(
  cuts: CutPoint[],
  endFrame: number,
  cameraCount: number,
): CutPoint[] {
  if (cuts.length === 0) {
    throw new Error('Cut map is empty. Provide at least one cut point.')
  }

  // Sort by frame ascending.
  const sorted = [...cuts].sort((a, b) => a.frame - b.frame)

  // Deduplicate: if two cuts share the same frame, keep the last one.
  const deduped: CutPoint[] = []
  for (const cut of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].frame === cut.frame) {
      deduped[deduped.length - 1] = cut
    } else {
      deduped.push({ ...cut })
    }
  }

  // Validate first cut starts at frame 0.
  if (deduped[0].frame !== 0) {
    throw new Error(
      `Cut map must start at frame 0 (first cut is at frame ${deduped[0].frame}).`,
    )
  }

  // Validate camera IDs.
  for (const cut of deduped) {
    if (cut.camera < 1 || cut.camera > cameraCount) {
      throw new Error(
        `Cut at frame ${cut.frame} references camera ${cut.camera}, ` +
        `but only cameras 1–${cameraCount} were detected.`,
      )
    }
  }

  // Validate no zero-length intervals between consecutive cuts.
  for (let i = 0; i < deduped.length - 1; i++) {
    if (deduped[i + 1].frame <= deduped[i].frame) {
      throw new Error(`Zero-length interval at frame ${deduped[i].frame}.`)
    }
  }

  // Validate endFrame is past the last cut.
  if (endFrame <= deduped[deduped.length - 1].frame) {
    throw new Error(
      `endFrame (${endFrame}) must be greater than the last cut at frame ${deduped[deduped.length - 1].frame}.`,
    )
  }

  return deduped
}

// ── Frame mapping ─────────────────────────────────────────────────────────────

/**
 * Map a timeline frame to a media source frame.
 *
 *   sourceFrame = timelineFrame - clipStartFrame + clipInFrame
 */
export function computeSourceFrame(
  timelineFrame: number,
  clipStartFrame: number,
  clipInFrame: number,
): number {
  return timelineFrame - clipStartFrame + clipInFrame
}

// ── Coverage validation ───────────────────────────────────────────────────────

/**
 * Verify every cut interval falls within its camera's available media range.
 * Throws if any interval is out of range. No clamping. No skipping.
 */
export function validateCoverage(
  intervals: CutInterval[],
  sources: CameraSource[],
): void {
  for (const iv of intervals) {
    const src = sources.find(s => s.camera === iv.camera)
    if (!src) {
      throw new Error(
        `Cut interval references camera ${iv.camera}, which was not detected.`,
      )
    }

    if (iv.sourceInFrame < src.clipInFrame || iv.sourceOutFrame > src.clipOutFrame) {
      throw new Error(
        `Camera ${iv.camera} has no media for timeline frames ${iv.startFrame}–${iv.endFrame} ` +
        `(needs source frames ${iv.sourceInFrame}–${iv.sourceOutFrame}, ` +
        `but media covers ${src.clipInFrame}–${src.clipOutFrame}). ` +
        `Re-sync cameras or adjust the cut map.`,
      )
    }
  }
}

// ── Interval building ─────────────────────────────────────────────────────────

/**
 * Build validated cut intervals from a normalized cut map.
 *
 * @param cuts       Normalized cut points (from normalizeCutMap).
 * @param endFrame   Exclusive end frame of the application range.
 * @param sources    Detected camera sources.
 * @returns Array of CutIntervals. Throws on coverage failure.
 */
export function buildCutIntervals(
  cuts: CutPoint[],
  endFrame: number,
  sources: CameraSource[],
): CutInterval[] {
  const intervals: CutInterval[] = []

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]
    const nextFrame = i + 1 < cuts.length ? cuts[i + 1].frame : endFrame
    const src = sources.find(s => s.camera === cut.camera)
    if (!src) {
      throw new Error(
        `Cut at frame ${cut.frame} references camera ${cut.camera}, which was not detected.`,
      )
    }

    const sourceInFrame = computeSourceFrame(cut.frame, src.clipStartFrame, src.clipInFrame)
    const sourceOutFrame = computeSourceFrame(nextFrame, src.clipStartFrame, src.clipInFrame)

    intervals.push({
      startFrame: cut.frame,
      endFrame: nextFrame,
      camera: cut.camera,
      sourceInFrame,
      sourceOutFrame,
    })
  }

  validateCoverage(intervals, sources)

  return intervals
}
