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

export class MockPremiereAdapter implements PremiereAdapter {
  async getActiveSequence() { await wait(100); return sequence }
  async getTranscript(sequenceId: string) { void sequenceId; await wait(180); return transcript }
  async addMarkers(sequenceId: string, decisions: EditDecision[]) { void sequenceId; void decisions; await wait(550) }
  async createRoughCut(sequenceId: string, decisions: EditDecision[], mappings: SpeakerMapping[]) {
    void sequenceId; void decisions; void mappings
    await wait(900)
    return 'Episode 042 - Guest Interview - AI Rough Cut'
  }
}

export const premiere = new MockPremiereAdapter()
