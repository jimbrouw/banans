import { describe, expect, it } from 'vitest'
import {
  buildCutIntervals,
  buildDetectionFingerprint,
  classifyTrackForDetection,
  computeSourceFrame,
  normalizeCutMap,
  selectOutputTrack,
  selectTimelineSegmentsForIntervals,
  validateCoverage,
  validateDetectedSources,
} from './cutEngine'
import type { CameraSource, CutInterval, CutPoint } from './cutEngine'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal CameraSource for testing. */
function cam(camera: number, overrides: Partial<CameraSource> = {}): CameraSource {
  return {
    vIndex: camera - 1,
    camera,
    name: `cam${camera}.mp4`,
    mediaPath: `/media/cam${camera}.mp4`,
    clipStartFrame: 0,
    clipInFrame: 0,
    clipOutFrame: 18000,
    ...overrides,
  }
}

const threeCams = [cam(1), cam(2), cam(3)]

// ── classifyTrackForDetection ─────────────────────────────────────────────────

describe('classifyTrackForDetection', () => {
  it('classifies a single media clip as camera', () => {
    expect(classifyTrackForDetection(1, false, false)).toBe('camera')
  })

  it('classifies an empty track as skip', () => {
    expect(classifyTrackForDetection(0, false, false)).toBe('skip')
  })

  it('classifies a multi-clip track as end', () => {
    expect(classifyTrackForDetection(3, false, false)).toBe('end')
  })

  it('classifies an adjustment layer as skip', () => {
    expect(classifyTrackForDetection(1, false, true)).toBe('skip')
  })

  it('classifies a nested sequence as end', () => {
    expect(classifyTrackForDetection(1, true, false)).toBe('end')
  })
})

// ── selectOutputTrack ─────────────────────────────────────────────────────────

describe('selectOutputTrack', () => {
  it('selects the first empty track above contiguous cameras', () => {
    // V1–V3 are cameras (0–2), V4 (index 3) is empty, trackCount=5
    const result = selectOutputTrack(threeCams, 5, (v) => v === 3 ? 0 : 1)
    expect(result).toBe(3)
  })

  it('skips occupied tracks above cameras', () => {
    // V4 (index 3) has items, V5 (index 4) is empty
    const result = selectOutputTrack(threeCams, 6, (v) => v === 4 ? 0 : 1)
    expect(result).toBe(4)
  })

  it('returns videoTrackCount when no empty track exists', () => {
    // All tracks 3–4 are occupied, trackCount=5
    const result = selectOutputTrack(threeCams, 5, () => 1)
    expect(result).toBe(5)
  })

  it('handles gap in camera stack (V1, V3)', () => {
    const gapCams = [cam(1, { vIndex: 0 }), cam(2, { vIndex: 2 })]
    // max(vIndex) = 2, so first candidate is 3, which is empty
    const result = selectOutputTrack(gapCams, 5, (v) => v === 3 ? 0 : 1)
    expect(result).toBe(3)
  })

  it('returns videoTrackCount for empty sources', () => {
    expect(selectOutputTrack([], 4, () => 0)).toBe(4)
  })
})

// ── validateDetectedSources ───────────────────────────────────────────────────

describe('validateDetectedSources', () => {
  it('rejects fewer than 2 cameras', () => {
    expect(() => validateDetectedSources([cam(1)], 1)).toThrow('only 1 camera track')
  })

  it('rejects 0 cameras', () => {
    expect(() => validateDetectedSources([], 0)).toThrow('found no camera tracks')
  })

  it('accepts 2 cameras', () => {
    expect(() => validateDetectedSources([cam(1), cam(2)], 2)).not.toThrow()
  })

  it('rejects target track occupied by a camera', () => {
    expect(() => validateDetectedSources(threeCams, 1)).toThrow('occupied by camera 2')
  })
})

// ── buildDetectionFingerprint ─────────────────────────────────────────────────

describe('buildDetectionFingerprint', () => {
  it('produces the same string for the same inputs', () => {
    const a = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 0, threeCams)
    const b = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 0, threeCams)
    expect(a).toBe(b)
  })

  it('produces a different string when a source changes', () => {
    const a = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 0, threeCams)
    const modified = [...threeCams]
    modified[1] = cam(2, { clipStartFrame: 10 })
    const b = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 0, modified)
    expect(a).not.toBe(b)
  })

  it('includes frameRate in the snapshot', () => {
    const a = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 0, threeCams)
    const b = buildDetectionFingerprint('seq1', 25, 18000, 3, 0, threeCams)
    expect(a).not.toBe(b)
  })

  it('includes targetTrackItemCount in the snapshot', () => {
    const a = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 0, threeCams)
    const b = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 5, threeCams)
    expect(a).not.toBe(b)
  })

  it('includes totalFrames in the snapshot', () => {
    const a = buildDetectionFingerprint('seq1', 29.97, 18000, 3, 0, threeCams)
    const b = buildDetectionFingerprint('seq1', 29.97, 9000, 3, 0, threeCams)
    expect(a).not.toBe(b)
  })
})

// ── normalizeCutMap ───────────────────────────────────────────────────────────

describe('normalizeCutMap', () => {
  it('passes through a valid sorted cut map', () => {
    const cuts: CutPoint[] = [{ frame: 0, camera: 1 }, { frame: 100, camera: 2 }]
    const result = normalizeCutMap(cuts, 200, 3)
    expect(result).toEqual(cuts)
  })

  it('sorts an unsorted cut map', () => {
    const cuts: CutPoint[] = [{ frame: 100, camera: 2 }, { frame: 0, camera: 1 }]
    const result = normalizeCutMap(cuts, 200, 3)
    expect(result[0].frame).toBe(0)
    expect(result[1].frame).toBe(100)
  })

  it('deduplicates same-frame cuts, keeping the last', () => {
    const cuts: CutPoint[] = [
      { frame: 0, camera: 1 },
      { frame: 100, camera: 2 },
      { frame: 100, camera: 3 },
    ]
    const result = normalizeCutMap(cuts, 200, 3)
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({ frame: 100, camera: 3 })
  })

  it('rejects a cut map that does not start at frame 0', () => {
    expect(() => normalizeCutMap([{ frame: 50, camera: 1 }], 200, 3))
      .toThrow('must start at frame 0')
  })

  it('rejects invalid camera IDs', () => {
    expect(() => normalizeCutMap([{ frame: 0, camera: 5 }], 200, 3))
      .toThrow('references camera 5')
  })

  it('rejects camera ID 0', () => {
    expect(() => normalizeCutMap([{ frame: 0, camera: 0 }], 200, 3))
      .toThrow('references camera 0')
  })

  it('rejects zero-length intervals', () => {
    // This is valid after dedup (100 > 0). Test a real zero-length:
    // This can't actually happen after sort+dedup since we keep one per frame.
    // But endFrame <= lastCut triggers the other validation.
    expect(() => normalizeCutMap([{ frame: 0, camera: 1 }], 0, 3))
      .toThrow('endFrame (0) must be greater')
  })

  it('rejects endFrame at or before the last cut', () => {
    expect(() => normalizeCutMap(
      [{ frame: 0, camera: 1 }, { frame: 100, camera: 2 }], 100, 3,
    )).toThrow('endFrame (100) must be greater than the last cut at frame 100')
  })

  it('rejects an empty cut map', () => {
    expect(() => normalizeCutMap([], 200, 3)).toThrow('empty')
  })
})

// ── computeSourceFrame ────────────────────────────────────────────────────────

describe('computeSourceFrame', () => {
  it('returns identity when offsets are zero', () => {
    expect(computeSourceFrame(100, 0, 0)).toBe(100)
  })

  it('shifts by clip start frame', () => {
    // Timeline frame 200, clip starts at frame 50, in-point 0
    // sourceFrame = 200 - 50 + 0 = 150
    expect(computeSourceFrame(200, 50, 0)).toBe(150)
  })

  it('applies non-zero in-point', () => {
    // Timeline frame 200, clip starts at 0, in-point at 30
    // sourceFrame = 200 - 0 + 30 = 230
    expect(computeSourceFrame(200, 0, 30)).toBe(230)
  })

  it('returns clipInFrame when timelineFrame equals clipStartFrame', () => {
    expect(computeSourceFrame(50, 50, 30)).toBe(30)
  })

  it('handles combined start and in-point offsets', () => {
    // Timeline frame 300, clip starts at 100, in-point 60
    // sourceFrame = 300 - 100 + 60 = 260
    expect(computeSourceFrame(300, 100, 60)).toBe(260)
  })
})

// ── validateCoverage ──────────────────────────────────────────────────────────

describe('validateCoverage', () => {
  const sources = [
    cam(1, { clipInFrame: 0, clipOutFrame: 1000 }),
    cam(2, { clipInFrame: 0, clipOutFrame: 1000 }),
  ]

  it('does not throw when all intervals are covered', () => {
    const intervals: CutInterval[] = [
      { startFrame: 0, endFrame: 500, camera: 1, sourceInFrame: 0, sourceOutFrame: 500 },
      { startFrame: 500, endFrame: 1000, camera: 2, sourceInFrame: 500, sourceOutFrame: 1000 },
    ]
    expect(() => validateCoverage(intervals, sources)).not.toThrow()
  })

  it('throws when source in-frame is below clip in-point', () => {
    const intervals: CutInterval[] = [
      { startFrame: 0, endFrame: 500, camera: 1, sourceInFrame: -10, sourceOutFrame: 500 },
    ]
    expect(() => validateCoverage(intervals, sources)).toThrow('has no media')
  })

  it('throws when source out-frame exceeds clip out-point', () => {
    const intervals: CutInterval[] = [
      { startFrame: 0, endFrame: 500, camera: 1, sourceInFrame: 0, sourceOutFrame: 1001 },
    ]
    expect(() => validateCoverage(intervals, sources)).toThrow('has no media')
  })

  it('includes frame numbers in error message', () => {
    const intervals: CutInterval[] = [
      { startFrame: 100, endFrame: 200, camera: 1, sourceInFrame: 100, sourceOutFrame: 1100 },
    ]
    expect(() => validateCoverage(intervals, sources)).toThrow('timeline frames 100–200')
    expect(() => validateCoverage(intervals, sources)).toThrow('source frames 100–1100')
    expect(() => validateCoverage(intervals, sources)).toThrow('media covers 0–1000')
  })

  it('throws when camera is not in sources', () => {
    const intervals: CutInterval[] = [
      { startFrame: 0, endFrame: 500, camera: 5, sourceInFrame: 0, sourceOutFrame: 500 },
    ]
    expect(() => validateCoverage(intervals, sources)).toThrow('camera 5')
  })
})

// ── buildCutIntervals ─────────────────────────────────────────────────────────

describe('buildCutIntervals', () => {
  it('builds intervals for a standard 3-cam cut map', () => {
    const cuts: CutPoint[] = [
      { frame: 0, camera: 1 },
      { frame: 500, camera: 2 },
      { frame: 1000, camera: 3 },
    ]
    const result = buildCutIntervals(cuts, 1500, threeCams)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      startFrame: 0, endFrame: 500, camera: 1,
      sourceInFrame: 0, sourceOutFrame: 500,
    })
    expect(result[1]).toEqual({
      startFrame: 500, endFrame: 1000, camera: 2,
      sourceInFrame: 500, sourceOutFrame: 1000,
    })
    expect(result[2]).toEqual({
      startFrame: 1000, endFrame: 1500, camera: 3,
      sourceInFrame: 1000, sourceOutFrame: 1500,
    })
  })

  it('handles offset cameras with non-zero clip start and in-point', () => {
    const offsetCams = [
      cam(1, { clipStartFrame: 0, clipInFrame: 0, clipOutFrame: 1000 }),
      cam(2, { clipStartFrame: 100, clipInFrame: 60, clipOutFrame: 1060 }),
    ]
    const cuts: CutPoint[] = [
      { frame: 0, camera: 1 },
      { frame: 300, camera: 2 },
    ]
    const result = buildCutIntervals(cuts, 600, offsetCams)
    expect(result).toHaveLength(2)
    // Camera 2: sourceIn = 300 - 100 + 60 = 260, sourceOut = 600 - 100 + 60 = 560
    expect(result[1]).toEqual({
      startFrame: 300, endFrame: 600, camera: 2,
      sourceInFrame: 260, sourceOutFrame: 560,
    })
  })

  it('throws when coverage validation fails', () => {
    const shortCams = [
      cam(1, { clipOutFrame: 100 }),
      cam(2, { clipOutFrame: 100 }),
    ]
    const cuts: CutPoint[] = [
      { frame: 0, camera: 1 },
      { frame: 50, camera: 2 },
    ]
    // endFrame 200 means camera 2 needs source frames 50–200, but media only covers 0–100
    expect(() => buildCutIntervals(cuts, 200, shortCams)).toThrow('has no media')
  })

  it('throws when a cut references an unknown camera', () => {
    const cuts: CutPoint[] = [{ frame: 0, camera: 99 }]
    expect(() => buildCutIntervals(cuts, 100, threeCams)).toThrow('camera 99')
  })
})

// ── selectTimelineSegmentsForIntervals ────────────────────────────────────────

describe('selectTimelineSegmentsForIntervals', () => {
  it('selects bladed segments whose boundaries drift by a frame', () => {
    const segments = [
      { startFrame: 0, endFrame: 89, item: 'a' },
      { startFrame: 89, endFrame: 210, item: 'b' },
      { startFrame: 211, endFrame: 300, item: 'c' },
    ]
    const intervals: CutInterval[] = [
      { startFrame: 90, endFrame: 210, camera: 1, sourceInFrame: 90, sourceOutFrame: 210 },
      { startFrame: 210, endFrame: 300, camera: 2, sourceInFrame: 210, sourceOutFrame: 300 },
    ]

    expect(selectTimelineSegmentsForIntervals(segments, intervals)).toEqual(['b', 'c'])
  })

  it('does not treat an unbladed full-length clip as a valid interval segment', () => {
    const segments = [
      { startFrame: 0, endFrame: 300, item: 'wide-full' },
    ]
    const intervals: CutInterval[] = [
      { startFrame: 90, endFrame: 210, camera: 1, sourceInFrame: 90, sourceOutFrame: 210 },
    ]

    expect(() => selectTimelineSegmentsForIntervals(segments, intervals)).toThrow('90-210')
  })
})
