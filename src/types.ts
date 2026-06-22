export type { CameraSource, CutInterval, CutPoint, DetectedSources } from './cutEngine'
import type { CutPoint, DetectedSources } from './cutEngine'

export type MarkerType = 'social_clip' | 'chapter' | 'suggested_trim' | 'warning' | 'strong_quote' | 'camera_switch' | 'social_hook'

export interface TranscriptSegment {
  id: string
  speaker: string
  start: number
  end: number
  text: string
  confidence: number
}

export interface EditDecision {
  id: string
  start: number
  end?: number
  type: MarkerType
  label: string
  detail: string
  confidence: number
  selected: boolean
}

export interface SpeakerMapping {
  speaker: string
  camera: string
}

export interface AnalysisSettings {
  socialClips: boolean
  chapters: boolean
  suggestedTrims: boolean
  pauseMarkers: boolean
  cameraPlan: boolean
  minimumClipSeconds: number
  confidenceThreshold: number
  minimumPauseSeconds: number
  minimumShotSeconds: number
  fillerAggressiveness: 'low' | 'medium' | 'high'
}

export interface SequenceInfo {
  id: string
  name: string
  duration: number
  transcriptCoverage: number
}

export interface PremiereAdapter {
  getActiveSequence(): Promise<SequenceInfo>
  getTranscript(sequenceId: string): Promise<TranscriptSegment[]>
  importTranscriptFile(): Promise<TranscriptSegment[]>
  addMarkers(sequenceId: string, decisions: EditDecision[]): Promise<void>
  createRoughCut(sequenceId: string, decisions: EditDecision[], mappings: SpeakerMapping[]): Promise<string>
  detectSources(): Promise<DetectedSources>
  applyCutMap(sequenceId: string, cuts: CutPoint[], det: DetectedSources, endFrame: number): Promise<string>
  assembleSocialSequence(sequenceId: string, decisions: EditDecision[], mappings: SpeakerMapping[], det: DetectedSources): Promise<string>
}
