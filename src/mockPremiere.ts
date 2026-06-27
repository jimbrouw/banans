import { parseTranscriptFile } from './transcriptParse'
import type { CutPoint, DetectedSources } from './cutEngine'
import type { EditDecision, PremiereAdapter, SequenceInfo, SpeakerMapping, TranscriptSegment } from './types'

export const sequence: SequenceInfo = {
  id: 'seq-042',
  name: 'Episode 042 - Guest Interview',
  duration: 2142,
  transcriptCoverage: 98,
}

export const transcript: TranscriptSegment[] = [
  { id: 's1', speaker: 'Host', start: 187, end: 226, text: 'What is the biggest mistake most creators make when they start?', confidence: 0.98 },
  { id: 's2', speaker: 'Guest', start: 226, end: 271, text: 'They optimise for output before they understand who they are helping.', confidence: 0.96 },
  { id: 's3', speaker: 'Guest', start: 398, end: 451, text: 'The creator journey has three distinct stages.', confidence: 0.97 },
  { id: 's4', speaker: 'Host', start: 552, end: 559, text: 'Um, I think, I think that is worth repeating.', confidence: 0.89 },
  { id: 's5', speaker: 'Guest', start: 867, end: 911, text: 'Consistency beats motivation because it removes the daily negotiation.', confidence: 0.95 },
  { id: 's6', speaker: 'Guest', start: 1110, end: 1178, text: 'A system should make the next useful action obvious.', confidence: 0.94 },
  { id: 's7', speaker: 'Host', start: 1328, end: 1343, text: 'Right, right. Let us come back to that.', confidence: 0.84 },
  { id: 's8', speaker: 'Guest', start: 1507, end: 1544, text: 'Focus is a choice you make daily, not a trait you are born with.', confidence: 0.93 },
]

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const pickBrowserFile = () => new Promise<File | undefined>((resolve) => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.prtranscript,.json,.csv,.srt,.txt'
  input.onchange = () => resolve(input.files?.[0])
  input.oncancel = () => resolve(undefined)
  input.click()
})

export class MockPremiereAdapter implements PremiereAdapter {
  async getActiveSequence() { await wait(100); return sequence }
  async getTranscript(sequenceId: string) { void sequenceId; await wait(180); return transcript }
  async importTranscriptFile() {
    const file = await pickBrowserFile()
    if (!file) return []
    const segments = parseTranscriptFile(await file.text(), file.name)
    if (!segments.length) throw new Error('That file did not contain a readable transcript.')
    return segments.sort((a, b) => a.start - b.start)
  }
  async addMarkers(sequenceId: string, decisions: EditDecision[]) { void sequenceId; void decisions; await wait(550) }
  async createRoughCut(sequenceId: string, decisions: EditDecision[], mappings: SpeakerMapping[]) {
    void sequenceId; void decisions; void mappings
    await wait(900)
    return 'Episode 042 - Guest Interview - AI Rough Cut'
  }
  async detectSources(): Promise<DetectedSources> {
    await wait(200)
    return {
      sequenceId: 'seq-042',
      fingerprint: '{"sequenceId":"seq-042","frameRate":29.97,"totalFrames":17982,"targetTrackIndex":3,"targetTrackItemCount":0,"sources":[]}',
      sources: [
        { vIndex: 0, camera: 1, name: 'cam1.mp4', mediaPath: '/mock/cam1.mp4', clipStartFrame: 0, clipInFrame: 0, clipOutFrame: 17982 },
        { vIndex: 1, camera: 2, name: 'cam2.mp4', mediaPath: '/mock/cam2.mp4', clipStartFrame: 0, clipInFrame: 0, clipOutFrame: 17982 },
        { vIndex: 2, camera: 3, name: 'cam3.mp4', mediaPath: '/mock/cam3.mp4', clipStartFrame: 0, clipInFrame: 0, clipOutFrame: 17982 },
      ],
      targetTrackIndex: 3,
      totalFrames: 17982,
      frameRate: 29.97,
    }
  }
  async applyCutMap(sequenceId: string, cuts: CutPoint[], det: DetectedSources, endFrame: number) {
    void sequenceId; void cuts; void det; void endFrame
    await wait(500)
    return 'Episode 042 - Guest Interview - Auto Cut'
  }
  async assembleSocialSequence(sequenceId: string, decisions: EditDecision[], mappings: SpeakerMapping[], det: DetectedSources) {
    void sequenceId; void decisions; void mappings; void det
    await wait(500)
    return 'Episode 042 - Guest Interview - Cold Open'
  }
  async assembleColdOpenClip(sequenceId: string, startSeconds: number, endSeconds: number) {
    void sequenceId; void startSeconds; void endSeconds
    await wait(500)
    return 'Episode 042 - Guest Interview - Cold Open'
  }
}

export const premiere = new MockPremiereAdapter()

