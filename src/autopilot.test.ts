import { describe, expect, it } from 'vitest'
import {
  resolveCameraNum,
  generateCutMapForProfile,
  evaluateCutMap,
  getAutopilotOptions,
} from './autopilot'
import type { TranscriptSegment, SpeakerMapping } from './types'

describe('autopilot.ts unit tests', () => {
  const mockSources = [
    { camera: 1, name: 'Gary_Fisher_Cam1.mp4' },
    { camera: 2, name: 'Gary_Fisher_Cam2.mp4' },
    { camera: 3, name: 'Gary_Fisher_Wide.mp4' },
  ]

  const mockMappings: SpeakerMapping[] = [
    { speaker: 'Host', camera: 'Camera 1' },
    { speaker: 'Guest', camera: 'Camera 2' },
  ]

  describe('resolveCameraNum', () => {
    it('matches exact and substring name values', () => {
      expect(resolveCameraNum('Gary_Fisher_Cam1.mp4', mockSources)).toBe(1)
      expect(resolveCameraNum('Cam2', mockSources)).toBe(2)
      expect(resolveCameraNum('Wide', mockSources)).toBe(3)
      expect(resolveCameraNum('Camera 2', mockSources)).toBe(2)
      expect(resolveCameraNum('Unknown', mockSources)).toBe(1) // default fallback
    });
  });

  describe('generateCutMapForProfile', () => {
    const mockSegments: TranscriptSegment[] = [
      { id: '1', start: 0, end: 5, speaker: 'Host', text: 'Hello and welcome to the show.', confidence: 0.95 },
      { id: '2', start: 5.5, end: 12, speaker: 'Guest', text: 'Thanks for having me here today!', confidence: 0.92 },
      { id: '3', start: 12.5, end: 13, speaker: 'Host', text: 'Yeah.', confidence: 0.99 }, // interjection
      { id: '4', start: 13.5, end: 20, speaker: 'Host', text: 'Let start by discussing the main topic of the day.', confidence: 0.97 }
    ]

    it('generates cuts for Balanced profile', () => {
      const profile = {
        name: 'Balanced',
        description: '',
        minShotSeconds: 2.5,
        switchAggressiveness: 'medium' as const
      }
      const cuts = generateCutMapForProfile(mockSegments, mockMappings, mockSources, profile, 600, 30)

      // Expected switches:
      // - frame 0: Camera 1 (Host start)
      // - frame 165 (5.5s): Camera 2 (Guest turn start, meets 2.5s min shot)
      // - segment 3 (Yeah) is skipped (aggressiveness medium, duration 0.5s is below 2.5s)
      // - segment 4 starts at 13.5s (frame 405), Host. Since segment 2 was active since 5.5s,
      //   it's been 8 seconds (>= 2.5s limit), so we switch to Camera 1.
      expect(cuts).toEqual([
        { frame: 0, camera: 1 },
        { frame: 165, camera: 2 },
        { frame: 405, camera: 1 }
      ])
    })

    it('does not skip interjections in High Aggressiveness / Dynamic Profile', () => {
      const profile = {
        name: 'Dynamic',
        description: '',
        minShotSeconds: 1.0,
        switchAggressiveness: 'high' as const
      }
      const cuts = generateCutMapForProfile(mockSegments, mockMappings, mockSources, profile, 600, 30)

      // Since it's dynamic with high aggressiveness, the short "Yeah" turn (Host, 12.5s -> 13s) is not skipped.
      expect(cuts.map(c => c.frame)).toContain(375) // 12.5s * 30 = 375
    })

    it('rotates cameras when the transcript has no speaker diarization', () => {
      // Every segment is the same speaker ("Unknown" with no mapping) → speaker-based
      // switching yields a single camera, so the rotation fallback must kick in.
      const noSpeakerSegments: TranscriptSegment[] = Array.from({ length: 30 }, (_, i) => ({
        id: `${i}`, start: i * 4, end: i * 4 + 3.5, speaker: 'Unknown',
        text: `Segment number ${i} of the conversation.`, confidence: 0.9,
      }))
      const profile = {
        name: 'Balanced', description: '', minShotSeconds: 2.5, switchAggressiveness: 'medium' as const,
      }
      const cuts = generateCutMapForProfile(noSpeakerSegments, [], mockSources, profile, 30 * 120, 30)

      // Multiple distinct cameras, starting at frame 0, switching no faster than 7.5s.
      expect(cuts.length).toBeGreaterThan(2)
      expect(cuts[0]).toEqual({ frame: 0, camera: 1 })
      expect(new Set(cuts.map((c) => c.camera)).size).toBeGreaterThan(1)
      for (let i = 1; i < cuts.length; i++) {
        expect((cuts[i].frame - cuts[i - 1].frame) / 30).toBeGreaterThanOrEqual(7.5)
      }
    })
  })

  describe('evaluateCutMap', () => {
    const mockSegments: TranscriptSegment[] = [
      { id: '1', start: 0, end: 4, speaker: 'Host', text: 'Hello', confidence: 0.95 },
      { id: '2', start: 4.5, end: 8, speaker: 'Guest', text: 'Welcome', confidence: 0.92 }
    ]

    it('evaluates and passes rules for balanced cuts', () => {
      const profile = {
        name: 'Balanced',
        description: '',
        minShotSeconds: 2.0,
        switchAggressiveness: 'medium' as const
      }
      const cuts = [
        { frame: 0, camera: 1 },
        { frame: 135, camera: 2 } // 4.5s * 30 = 135
      ]
      const evalResult = evaluateCutMap(cuts, mockSegments, mockMappings, mockSources, profile, 300, 30)
      expect(evalResult.score).toBe(100)
      expect(evalResult.checks.every(c => c.pass)).toBe(true)
    })

    it('flags minimum shot violations', () => {
      const profile = {
        name: 'Balanced',
        description: '',
        minShotSeconds: 5.0, // force violation
        switchAggressiveness: 'medium' as const
      }
      const cuts = [
        { frame: 0, camera: 1 },
        { frame: 60, camera: 2 } // 2.0s
      ]
      const evalResult = evaluateCutMap(cuts, mockSegments, mockMappings, mockSources, profile, 300, 30)
      expect(evalResult.score).toBeLessThan(100)
      const shotCheck = evalResult.checks.find(c => c.label === 'Shot Duration Check')
      expect(shotCheck?.pass).toBe(false)
    })
  })

  describe('getAutopilotOptions', () => {
    it('returns ranked options for a transcript', () => {
      const mockSegments: TranscriptSegment[] = [
        { id: '1', start: 0, end: 5, speaker: 'Host', text: 'Talk talk talk', confidence: 0.9 }
      ]
      const options = getAutopilotOptions(mockSegments, mockMappings, mockSources, 300, 30)
      expect(options.length).toBe(3)
      expect(options[0].score).toBeGreaterThanOrEqual(options[1].score)
    })
  })
})
