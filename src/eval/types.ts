export interface EvalShot {
  start: number
  end: number
  camera: string
}

export interface EvalTranscriptSegment {
  start: number
  end: number
  speaker: string
  text: string
}

export interface MicActivity {
  start: number
  end: number
  mic: string
  level: number
}

export interface TimelineSnapshot {
  sequenceId: string
  sequenceName: string
  clipCount: number
  clipFingerprint: string
  markerCount: number
}

export interface ErrorExpectation {
  condition: 'missing_camera' | 'missing_mic' | 'bad_sync' | 'missing_transcript'
  handled: boolean
  message?: string
}

export interface EvalRun {
  episodeId: string
  durationSeconds: number
  cameras: string[]
  mics: string[]
  speakerCameraMap: Record<string, string>
  micSpeakerMap: Record<string, string>
  transcript?: EvalTranscriptSegment[]
  micActivity?: MicActivity[]
  generatedShots: EvalShot[]
  referenceShots: EvalShot[]
  processingSeconds: number
  manualEditMinutes: number
  measuredCorrectionMinutes?: number
  timelineBefore: TimelineSnapshot
  originalAfter: TimelineSnapshot
  outputSequence: TimelineSnapshot
  rerunSequence?: TimelineSnapshot
  errorExpectations: ErrorExpectation[]
}

export interface EvalThresholds {
  cutToleranceSeconds: number
  minimumShotSeconds: number
  maximumCutsPerMinute: number
  minimumSpeakerAccuracy: number
  minimumCutTimingAccuracy: number
  minimumWideAccuracy: number
  minimumTimeSavedPercent: number
  maximumCorrectionMinutes60: number
  maximumProcessingSeconds: Record<10 | 30 | 60, number>
}

export interface BadCut {
  timecode: string
  seconds: number
  reason: string
  expectedCamera?: string
  actualCamera?: string
}

export interface EvalCheck {
  id: string
  label: string
  pass: boolean
  score: number
  weight: number
  hardGate?: boolean
  detail: string
}

export interface EvalReport {
  episodeId: string
  pass: boolean
  percentageAccuracy: number
  cutsPerMinute: number
  averageShotLengthSeconds: number
  correctionCount: number
  measuredCorrectionMinutes: number | null
  estimatedTimeSavedPercent: number
  confidenceScore: number
  badCuts: BadCut[]
  checks: EvalCheck[]
}
