import type {
  ClipProjectItem,
  premierepro,
  Project,
  Sequence,
  VideoClipTrackItem,
} from '@adobe/premierepro'
import { MockPremiereAdapter } from './mockPremiere'
import { getRuntimeRequire, isPremiereHost } from './hostRuntime'
import type { EditDecision, PremiereAdapter, SequenceInfo, SpeakerMapping, TranscriptSegment } from './types'

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' ? value as JsonRecord : undefined

const numberField = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

const stringField = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string
  return undefined
}

export function normalizeTranscriptJson(json: string, timelineOffset = 0): TranscriptSegment[] {
  const parsed = JSON.parse(json) as unknown
  const root = asRecord(parsed)
  if (!root) return []
  const candidates = [root.segments, root.transcript, root.items].find(Array.isArray)
  if (!Array.isArray(candidates)) return []

  return candidates.flatMap((candidate, index): TranscriptSegment[] => {
    const segment = asRecord(candidate)
    if (!segment) return []
    const words = Array.isArray(segment.words) ? segment.words.map(asRecord).filter(Boolean) as JsonRecord[] : []
    const firstWord = words[0]
    const lastWord = words.at(-1)
    const start = numberField(segment, 'start', 'startTime', 'start_time') ?? (firstWord && numberField(firstWord, 'start', 'startTime', 'start_time'))
    const explicitEnd = numberField(segment, 'end', 'endTime', 'end_time')
    const wordEnd = lastWord && (numberField(lastWord, 'end', 'endTime', 'end_time') ?? ((numberField(lastWord, 'start', 'startTime', 'start_time') ?? 0) + (numberField(lastWord, 'duration') ?? 0)))
    const end = explicitEnd ?? wordEnd ?? ((start ?? 0) + (numberField(segment, 'duration') ?? 0))
    const text = stringField(segment, 'text', 'transcript') ?? words.map((word) => stringField(word, 'text', 'word') ?? '').join(' ').trim()
    if (start === undefined || !text) return []

    return [{
      id: stringField(segment, 'id', 'guid') ?? `segment-${index}`,
      speaker: stringField(segment, 'speaker', 'speakerName', 'speaker_label') ?? 'Unknown',
      start: Math.max(0, timelineOffset + start),
      end: Math.max(0, timelineOffset + end),
      text,
      confidence: numberField(segment, 'confidence', 'confidenceScore') ?? 1,
    }]
  })
}

const markerType = (decision: EditDecision) => decision.type === 'chapter' ? 'Chapter' : 'Comment'

class UxpPremiereAdapter implements PremiereAdapter {
  private readonly ppro: premierepro

  constructor(ppro: premierepro) {
    this.ppro = ppro
  }

  private async context(): Promise<{ project: Project; sequence: Sequence }> {
    const project = await this.ppro.Project.getActiveProject()
    if (!project) throw new Error('Open a Premiere project before using RoughCut.')
    const sequence = await project.getActiveSequence()
    if (!sequence) throw new Error('Open a sequence in the Timeline before using RoughCut.')
    return { project, sequence }
  }

  async getActiveSequence(): Promise<SequenceInfo> {
    const { sequence } = await this.context()
    const end = await sequence.getEndTime()
    return { id: sequence.guid.toString(), name: sequence.name, duration: Math.max(0, Math.round(end.seconds)), transcriptCoverage: 0 }
  }

  async getTranscript(sequenceId: string): Promise<TranscriptSegment[]> {
    const { sequence } = await this.context()
    if (sequence.guid.toString() !== sequenceId) throw new Error('The active sequence changed. Refresh RoughCut and try again.')
    const seen = new Set<string>()
    const segments: TranscriptSegment[] = []

    for (let trackIndex = 0; trackIndex < await sequence.getVideoTrackCount(); trackIndex += 1) {
      const track = await sequence.getVideoTrack(trackIndex)
      const items = track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
      for (const item of items) await this.collectItemTranscript(item, seen, segments)
    }

    if (!segments.length) throw new Error('No source-clip transcript was found on the active sequence. Transcribe its source clips in Premiere, then try again.')
    return segments.sort((a, b) => a.start - b.start)
  }

  private async collectItemTranscript(item: VideoClipTrackItem, seen: Set<string>, output: TranscriptSegment[]) {
    try {
      const projectItem = await item.getProjectItem()
      const clipItem = this.ppro.ClipProjectItem.cast(projectItem) as ClipProjectItem
      if (!this.ppro.Transcript.hasTranscript(clipItem)) return
      const mediaPath = await clipItem.getMediaFilePath()
      const start = await item.getStartTime()
      const inPoint = await item.getInPoint()
      const key = `${mediaPath}:${start.seconds}:${inPoint.seconds}`
      if (seen.has(key)) return
      seen.add(key)
      const json = await this.ppro.Transcript.exportToJSON(clipItem)
      output.push(...normalizeTranscriptJson(json, start.seconds - inPoint.seconds))
    } catch {
      // Graphics, adjustment layers, and unsupported project item types are skipped.
    }
  }

  async addMarkers(sequenceId: string, decisions: EditDecision[]): Promise<void> {
    const { project, sequence } = await this.context()
    if (sequence.guid.toString() !== sequenceId) throw new Error('The active sequence changed before markers were written.')
    await this.writeMarkers(project, sequence, decisions, 'Add RoughCut markers')
  }

  private async writeMarkers(project: Project, sequence: Sequence, decisions: EditDecision[], undoLabel: string) {
    const markers = await this.ppro.Markers.getMarkers(sequence)
    const committed = project.executeTransaction((compound) => {
      for (const decision of decisions) {
        const start = this.ppro.TickTime.createWithSeconds(decision.start)
        const duration = this.ppro.TickTime.createWithSeconds(Math.max(0, (decision.end ?? decision.start) - decision.start))
        compound.addAction(markers.createAddMarkerAction(decision.label, markerType(decision), start, duration, `${decision.detail} | RoughCut confidence ${Math.round(decision.confidence * 100)}%`))
      }
    }, undoLabel)
    if (!committed) throw new Error('Premiere rejected the marker transaction.')
  }

  async createRoughCut(sequenceId: string, decisions: EditDecision[], mappings: SpeakerMapping[]): Promise<string> {
    void mappings
    const { project, sequence } = await this.context()
    if (sequence.guid.toString() !== sequenceId) throw new Error('The active sequence changed before the rough cut was created.')
    const existingIds = new Set((await project.getSequences()).map((item) => item.guid.toString()))
    const cloned = project.executeTransaction((compound) => compound.addAction(sequence.createCloneAction()), 'Create RoughCut sequence')
    if (!cloned) throw new Error('Premiere could not clone the active sequence.')
    const roughCut = (await project.getSequences()).find((item) => !existingIds.has(item.guid.toString()))
    if (!roughCut) throw new Error('Premiere cloned the sequence but did not return the new sequence.')
    const name = `${sequence.name} - AI Rough Cut`
    const projectItem = await roughCut.getProjectItem()
    const named = project.executeTransaction((compound) => compound.addAction(projectItem.createSetNameAction(name)), 'Name RoughCut sequence')
    if (!named) throw new Error('Premiere cloned the sequence but could not rename it.')
    await this.writeMarkers(project, roughCut, decisions, 'Add RoughCut markers')
    if (!await project.setActiveSequence(roughCut)) throw new Error('The rough cut was created, but Premiere could not open it.')
    return name
  }
}

export function createPremiereAdapter(): PremiereAdapter {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return new MockPremiereAdapter()
  return new UxpPremiereAdapter(runtimeRequire('premierepro') as premierepro)
}

export const premiere = createPremiereAdapter()
export { isPremiereHost }
