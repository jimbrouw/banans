import { describe, expect, it } from 'vitest'
import { shotToCamera, shotsToEnergyResetCuts } from './coldOpenAssembler'
import type { ColdOpenShot } from './coldOpenFinder'
import type { CameraSource } from './cutEngine'

const sources: CameraSource[] = [
  { vIndex: 0, camera: 1, name: 'Guest_Cam1.mp4', mediaPath: '/a.mp4', clipStartFrame: 0, clipInFrame: 0, clipOutFrame: 3600 },
  { vIndex: 1, camera: 2, name: 'Host_Cam2.mp4', mediaPath: '/b.mp4', clipStartFrame: 0, clipInFrame: 0, clipOutFrame: 3600 },
  { vIndex: 2, camera: 3, name: 'Wide_Shot.mp4', mediaPath: '/c.mp4', clipStartFrame: 0, clipInFrame: 0, clipOutFrame: 3600 },
]

describe('shotToCamera', () => {
  it('guest_tight → camera 1', () => {
    expect(shotToCamera('guest_tight', sources)).toBe(1)
  })
  it('host_reaction → camera 2', () => {
    expect(shotToCamera('host_reaction', sources)).toBe(2)
  })
  it('wide → camera 3 (resolved by name)', () => {
    expect(shotToCamera('wide', sources)).toBe(3)
  })
  it('wide → last camera when no wide source name', () => {
    const noWideSources = [
      { ...sources[0], name: 'Cam1.mp4' },
      { ...sources[1], name: 'Cam2.mp4' },
    ]
    // resolveCameraNum falls back to sources.length when no "wide" match
    expect(shotToCamera('wide', noWideSources)).toBe(2)
  })
})

describe('shotsToEnergyResetCuts', () => {
  const frameRate = 30
  const windowSeconds = 25

  const shots: ColdOpenShot[] = [
    { offsetSeconds: 0, shot: 'guest_tight' },
    { offsetSeconds: 3, shot: 'host_reaction' },
    { offsetSeconds: 7, shot: 'wide' },
    { offsetSeconds: 10, shot: 'guest_tight' },
    { offsetSeconds: 15, shot: 'host_reaction' },
    { offsetSeconds: 20, shot: 'guest_tight' },
  ]

  it('produces a cut at frame 0 for the first shot', () => {
    const cuts = shotsToEnergyResetCuts(shots, windowSeconds, sources, frameRate)
    expect(cuts[0]).toEqual({ frame: 0, camera: 1 })
  })

  it('converts offsetSeconds to frames correctly', () => {
    const cuts = shotsToEnergyResetCuts(shots, windowSeconds, sources, frameRate)
    // offset 3s → frame 90
    expect(cuts.some(c => c.frame === 90 && c.camera === 2)).toBe(true)
    // offset 7s → frame 210 (wide = cam 3)
    expect(cuts.some(c => c.frame === 210 && c.camera === 3)).toBe(true)
  })

  it('drops cuts that would violate the 3-second minimum', () => {
    const tightShots: ColdOpenShot[] = [
      { offsetSeconds: 0, shot: 'guest_tight' },
      { offsetSeconds: 1, shot: 'host_reaction' }, // too soon — dropped
      { offsetSeconds: 5, shot: 'wide' },
    ]
    const cuts = shotsToEnergyResetCuts(tightShots, windowSeconds, sources, frameRate)
    // Should skip the 1s offset; next valid cut is at 5s
    expect(cuts.length).toBe(2)
    expect(cuts[1].frame).toBe(5 * frameRate)
  })

  it('drops cuts beyond the window duration', () => {
    const overshotShots: ColdOpenShot[] = [
      { offsetSeconds: 0, shot: 'guest_tight' },
      { offsetSeconds: 10, shot: 'host_reaction' },
      { offsetSeconds: 30, shot: 'wide' }, // beyond 25s window
    ]
    const cuts = shotsToEnergyResetCuts(overshotShots, 25, sources, frameRate)
    expect(cuts.every(c => c.frame < 25 * frameRate)).toBe(true)
  })

  it('returns a single cut at frame 0 when shots array is empty', () => {
    const cuts = shotsToEnergyResetCuts([], windowSeconds, sources, frameRate)
    expect(cuts).toEqual([{ frame: 0, camera: 1 }])
  })

  it('all frames are non-negative integers', () => {
    const cuts = shotsToEnergyResetCuts(shots, windowSeconds, sources, frameRate)
    expect(cuts.every(c => Number.isInteger(c.frame) && c.frame >= 0)).toBe(true)
  })

  it('collapses to a single cut when all shots map to the same camera', () => {
    const sameCam: ColdOpenShot[] = [
      { offsetSeconds: 0, shot: 'guest_tight' },
      { offsetSeconds: 5, shot: 'guest_tight' },
      { offsetSeconds: 10, shot: 'guest_tight' },
    ]
    const cuts = shotsToEnergyResetCuts(sameCam, windowSeconds, sources, frameRate)
    expect(new Set(cuts.map(c => c.camera)).size).toBe(1)
  })
})
