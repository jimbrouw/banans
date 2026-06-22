import type { ErrorExpectation, EvalRun, EvalShot, EvalTranscriptSegment, TimelineSnapshot } from './types'

const errors: ErrorExpectation[] = [
  { condition: 'missing_camera', handled: true, message: 'Camera 3 is unavailable; review camera mapping.' },
  { condition: 'missing_mic', handled: true, message: 'Mic 2 is unavailable; transcript mode remains active.' },
  { condition: 'bad_sync', handled: true, message: 'Audio/video sync exceeds the safe tolerance.' },
  { condition: 'missing_transcript', handled: true, message: 'Transcript missing; using mic activity fallback.' },
]

const snapshot = (id: string, name: string): TimelineSnapshot => ({ sequenceId: id, sequenceName: name, clipCount: 5, clipFingerprint: 'cam1+cam2+wide+mic1+mic2@sync-v1', markerCount: 0 })

export function makeEpisode(minutes: 10 | 30 | 60, overrides: Partial<EvalRun> = {}): EvalRun {
  const durationSeconds = minutes * 60
  const generatedShots: EvalShot[] = []
  const referenceShots: EvalShot[] = []
  const transcript: EvalTranscriptSegment[] = []
  const cameras = ['Camera 1', 'Camera 2', 'Wide']
  let cursor = 0
  let index = 0
  while (cursor < durationSeconds) {
    const length = Math.min(index % 5 === 4 ? 12 : 18, durationSeconds - cursor)
    const camera = index % 5 === 4 ? 'Wide' : index % 2 ? 'Camera 2' : 'Camera 1'
    generatedShots.push({ start: cursor, end: cursor + length, camera })
    referenceShots.push({ start: cursor, end: cursor + length, camera })
    if (camera !== 'Wide') transcript.push({ start: cursor, end: cursor + length, speaker: camera === 'Camera 1' ? 'Host' : 'Guest', text: `Sustained speaker turn ${index}` })
    cursor += length
    index += 1
  }
  const before = snapshot(`episode-${minutes}`, `Episode ${minutes}`)
  return {
    episodeId: `synthetic-${minutes}min`, durationSeconds, cameras, mics: ['Mic 1', 'Mic 2'],
    speakerCameraMap: { Host: 'Camera 1', Guest: 'Camera 2' }, micSpeakerMap: { 'Mic 1': 'Host', 'Mic 2': 'Guest' },
    transcript, generatedShots, referenceShots, processingSeconds: minutes * 2, manualEditMinutes: minutes * 2,
    measuredCorrectionMinutes: minutes === 60 ? 20 : minutes / 3,
    timelineBefore: before, originalAfter: { ...before }, outputSequence: snapshot(`episode-${minutes}-roughcut`, `Episode ${minutes} - AI Rough Cut`),
    rerunSequence: snapshot(`episode-${minutes}-roughcut-2`, `Episode ${minutes} - AI Rough Cut 2`), errorExpectations: errors.map((item) => ({ ...item })), ...overrides,
  }
}
