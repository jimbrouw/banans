import { describe, expect, it } from 'vitest'
import { evaluateRun, formatReport } from './evaluate'
import { makeEpisode } from './fixtures'

describe('podcast rough-cut eval suite', () => {
  it.each([10, 30, 60] as const)('passes the trusted baseline for a %i-minute episode', (minutes) => {
    const report = evaluateRun(makeEpisode(minutes))
    expect(report.pass).toBe(true)
    expect(report.percentageAccuracy).toBeGreaterThanOrEqual(85)
    expect(report.badCuts).toEqual([])
  })

  it('enforces the 60-minute correction and time-saving acceptance gates', () => {
    const slowCorrection = evaluateRun(makeEpisode(60, { measuredCorrectionMinutes: 25 }))
    const lowSaving = evaluateRun(makeEpisode(60, { manualEditMinutes: 60, measuredCorrectionMinutes: 24 }))
    expect(slowCorrection.checks.find((check) => check.id === 'correction-time')?.pass).toBe(false)
    expect(lowSaving.estimatedTimeSavedPercent).toBeLessThan(60)
    expect(lowSaving.pass).toBe(false)
  })

  it('does not allow an estimated correction time to pass the 60-minute gate', () => {
    const report = evaluateRun(makeEpisode(60, { measuredCorrectionMinutes: undefined }))
    expect(report.checks.find((check) => check.id === 'correction-time')?.pass).toBe(false)
  })

  it('hard-fails destructive writes and unsafe reruns', () => {
    const episode = makeEpisode(30)
    const report = evaluateRun({ ...episode, originalAfter: { ...episode.originalAfter, clipCount: 4 }, rerunSequence: episode.outputSequence })
    expect(report.pass).toBe(false)
    expect(report.checks.filter((check) => check.hardGate && !check.pass).map((check) => check.id)).toEqual(['non-destructive', 'rerun'])
  })

  it('scores mic fallback when transcript data is missing', () => {
    const episode = makeEpisode(10)
    const report = evaluateRun({ ...episode, transcript: undefined, micActivity: [
      { start: 0, end: 18, mic: 'Mic 1', level: .9 },
      { start: 18, end: 36, mic: 'Mic 2', level: .9 },
    ] })
    expect(report.checks.find((check) => check.id === 'mic-fallback')).toMatchObject({ pass: true, score: 100 })
  })

  it('lists bad cuts with timecode and correction metrics', () => {
    const episode = makeEpisode(10)
    const shots = episode.generatedShots.map((shot) => ({ ...shot }))
    shots[1] = { start: 18.9, end: 20, camera: 'Camera 1' }
    const report = evaluateRun({ ...episode, generatedShots: shots })
    expect(report.pass).toBe(false)
    expect(report.correctionCount).toBeGreaterThan(0)
    expect(report.badCuts.some((cut) => cut.timecode === '00:00:19')).toBe(true)
    expect(formatReport(report)).toContain('Bad cuts:')
  })

  it('requires all four editor-facing error states', () => {
    const report = evaluateRun(makeEpisode(10, { errorExpectations: [{ condition: 'missing_transcript', handled: false }] }))
    expect(report.checks.find((check) => check.id === 'errors')?.pass).toBe(false)
    expect(report.pass).toBe(false)
  })
})
