import { describe, expect, it } from 'vitest'
import { detectSpeakers, FLOOR_DB, hasSpeakerLabels, placeEnvelope, talkShare, turnsToSegments } from './podcastSpeakers'
import type { TranscriptSegment } from './types'

// 10 frames per second. Build envelopes from [fromSec, toSec, dB] runs over a base level.
const env = (seconds: number, base: number, runs: [number, number, number][]) => {
  const out = new Array<number>(seconds * 10).fill(base)
  for (const [a, b, db] of runs) for (let i = a * 10; i < b * 10; i++) out[i] = db
  return out
}

describe('placeEnvelope', () => {
  it('places source levels where each clip sits on the timeline', () => {
    const levels = new Map([['/mic.wav', { rate: 10, db: Array.from({ length: 100 }, (_, i) => -i) }]])
    const out = placeEnvelope([{ path: '/mic.wav', start: 1, end: 2, inPoint: 5 }], levels, 3, 10)
    expect(out).toHaveLength(30)
    expect(out.slice(8, 12)).toEqual([FLOOR_DB, FLOOR_DB, -50, -51]) // timeline 1.0s = source 5.0s = frame 50
    expect(out[25]).toBe(FLOOR_DB)
  })
})

describe('detectSpeakers', () => {
  it('follows the louder mic and ignores bleed', () => {
    // Host talks 0-4s, guest 5-9s. Each mic hears the other 15 dB down (bleed).
    const host = env(10, -60, [[0, 4, -20], [5, 9, -35]])
    const guest = env(10, -60, [[0, 4, -35], [5, 9, -20]])
    expect(detectSpeakers([host, guest], 10)).toEqual([[{ start: 0, end: 4 }], [{ start: 5, end: 9 }]])
  })

  it('marks both active on real crosstalk', () => {
    const a = env(10, -60, [[0, 6, -20]])
    const b = env(10, -60, [[4, 10, -22]])
    const [ta, tb] = detectSpeakers([a, b], 10)
    expect(ta).toEqual([{ start: 0, end: 6 }])
    expect(tb).toEqual([{ start: 4, end: 10 }])
  })

  it('still detects a mic that talks almost all the time', () => {
    const guest = env(10, -60, [[1, 10, -20]])
    const host = env(10, -60, [[0, 1, -20], [1, 10, -38]])
    expect(detectSpeakers([host, guest], 10)).toEqual([[{ start: 0, end: 1 }], [{ start: 1, end: 10 }]])
  })

  it('bridges short breaths and drops blips', () => {
    const a = env(10, -60, [[0, 2, -20], [2.3, 4, -20], [6, 6.2, -20]])
    expect(detectSpeakers([a, env(10, -60, [])], 10)[0]).toEqual([{ start: 0, end: 4 }])
  })

  it('normalises to each mic’s own floor, so a quieter mic still wins its turns', () => {
    const loudMic = env(10, -50, [[0, 4, -15], [5, 9, -40]])
    const quietMic = env(10, -75, [[0, 4, -62], [5, 9, -45]])
    expect(detectSpeakers([loudMic, quietMic], 10)).toEqual([[{ start: 0, end: 4 }], [{ start: 5, end: 9 }]])
  })
})

describe('segments and summaries', () => {
  const turns = [[{ start: 0, end: 4 }], [{ start: 5, end: 7 }, { start: 8, end: 10 }]]

  it('turns become time-ordered segments labelled by mic', () => {
    expect(turnsToSegments(['Host', 'Guest'], turns).map((s) => [s.speaker, s.start, s.end])).toEqual([['Host', 0, 4], ['Guest', 5, 7], ['Guest', 8, 10]])
  })

  it('talk share sums to one', () => {
    expect(talkShare(turns)).toEqual([0.5, 0.5])
  })

  it('detects whether Premiere labelled speakers', () => {
    const seg = (speaker: string) => ({ speaker }) as TranscriptSegment
    expect(hasSpeakerLabels([seg('Speaker 1'), seg('Speaker 2')])).toBe(true)
    expect(hasSpeakerLabels([seg('Unknown'), seg('Unknown')])).toBe(false)
    expect(hasSpeakerLabels([seg('Speaker 1'), seg('Unknown')])).toBe(false)
  })
})
