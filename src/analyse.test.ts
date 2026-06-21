import { describe, expect, it, vi } from 'vitest'
import { analyseTranscript, cameraPlan, mergeTrimDecisions } from './analyse'
import type { AnalysisSettings, TranscriptSegment } from './types'

const settings: AnalysisSettings = {
  socialClips: false,
  chapters: false,
  suggestedTrims: true,
  pauseMarkers: true,
  cameraPlan: true,
  minimumClipSeconds: 15,
  confidenceThreshold: .6,
  minimumPauseSeconds: 1,
  minimumShotSeconds: 2.5,
  fillerAggressiveness: 'medium',
}

const segment = (id: string, speaker: string, start: number, end: number, text: string): TranscriptSegment => ({ id, speaker, start, end, text, confidence: .95 })

describe('editorial decision engine', () => {
  it('suppresses short acknowledgements and maps sustained turns to cameras', () => {
    const transcript = [segment('1', 'Host', 0, 8, 'A sustained opening question'), segment('2', 'Guest', 8, 9, 'Yeah'), segment('3', 'Guest', 10, 18, 'A sustained answer')]
    const result = cameraPlan(transcript, settings, [{ speaker: 'Host', camera: 'Camera 1' }, { speaker: 'Guest', camera: 'Camera 2' }])
    expect(result.map((item) => item.label)).toEqual(['Camera suggestion: Camera 1', 'Camera suggestion: Camera 2'])
  })

  it('uses the wide shot when different speakers overlap', () => {
    const transcript = [segment('1', 'Host', 0, 8, 'Question'), segment('2', 'Guest', 6, 14, 'Overlapping answer')]
    expect(cameraPlan(transcript, settings, []).at(0)?.label).toBe('Camera suggestion: Wide')
  })

  it('merges adjacent trim regions', () => {
    const result = mergeTrimDecisions([
      { id: '1', start: 1, end: 2, type: 'suggested_trim', label: 'Trim', detail: 'first', confidence: .8 },
      { id: '2', start: 2.05, end: 3, type: 'suggested_trim', label: 'Trim', detail: 'second', confidence: .9 },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ start: 1, end: 3, confidence: .9 })
  })

  it('creates pause and filler review decisions from transcript timing', async () => {
    vi.useFakeTimers()
    const pending = analyseTranscript([segment('1', 'Host', 0, 3, 'Um, this is the setup'), segment('2', 'Guest', 6, 10, 'The answer')], { ...settings, cameraPlan: false })
    await vi.advanceTimersByTimeAsync(450)
    const result = await pending
    vi.useRealTimers()
    expect(result.some((item) => item.label === 'Filler review')).toBe(true)
    expect(result.some((item) => item.label === 'Pause review')).toBe(true)
  })
})
