import type {
  ClipProjectItem,
  premierepro,
  Project,
  Sequence,
  VideoClipTrackItem,
} from '@adobe/premierepro'
import { MockPremiereAdapter } from './mockPremiere'
import { getRuntimeRequire, isPremiereHost } from './hostRuntime'
import { normalizeTranscriptJson, parseTranscriptFile } from './transcriptParse'
import type { EditDecision, PremiereAdapter, SequenceInfo, SpeakerMapping, TranscriptSegment } from './types'

export { normalizeTranscriptJson }

type UxpFileSystem = {
  storage: {
    localFileSystem: {
      getFileForOpening(options: { types?: string[] }): Promise<{ name: string; read(): Promise<string> } | undefined>
    }
  }
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
    void sequenceId
    const { sequence } = await this.context()

    // Strategy 1: the sequence's own transcript (Premiere "Transcribe Sequence").
    // A sequence is itself a ClipProjectItem, so attempt a direct read first —
    // this is the zero-friction path that needs no export from the Text panel.
    const sequenceTranscript = await this.collectSequenceTranscript(sequence)
    if (sequenceTranscript.length) return sequenceTranscript.sort((a, b) => a.start - b.start)

    // Strategy 2: transcripts attached to the source clips on the timeline.
    const seen = new Set<string>()
    const segments: TranscriptSegment[] = []
    for (let trackIndex = 0; trackIndex < await sequence.getVideoTrackCount(); trackIndex += 1) {
      const track = await sequence.getVideoTrack(trackIndex)
      const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
      for (const item of items) await this.collectItemTranscript(item, seen, segments)
    }
    if (segments.length) return segments.sort((a, b) => a.start - b.start)

    throw new Error('No transcript was found on the active sequence. Transcribe the sequence (or its source clips) in Premiere’s Text panel, or use "Load transcript file" to import a CSV exported from that panel.')
  }

  private async collectSequenceTranscript(sequence: Sequence): Promise<TranscriptSegment[]> {
    try {
      const projectItem = await sequence.getProjectItem()
      const clipItem = this.ppro.ClipProjectItem.cast(projectItem) as ClipProjectItem
      const json = await this.ppro.Transcript.exportToJSON(clipItem)
      return json ? normalizeTranscriptJson(json, 0) : []
    } catch {
      return []
    }
  }

  async importTranscriptFile(): Promise<TranscriptSegment[]> {
    const runtimeRequire = getRuntimeRequire()
    if (!runtimeRequire) throw new Error('File import is only available inside Premiere.')
    const fs = (runtimeRequire('uxp') as UxpFileSystem).storage.localFileSystem
    const file = await fs.getFileForOpening({ types: ['csv', 'srt', 'json', 'txt'] })
    if (!file) return []
    const content = await file.read()
    const segments = parseTranscriptFile(content, file.name, await this.sequenceFrameRate())
    if (!segments.length) throw new Error('That file did not contain a readable transcript. In Premiere’s Text panel use "Export to CSV File", then load that file.')
    return segments.sort((a, b) => a.start - b.start)
  }

  private async sequenceFrameRate(): Promise<number> {
    try {
      const { sequence } = await this.context()
      const settings = await sequence.getSettings()
      const frameRate = await settings.getVideoFrameRate()
      return frameRate.value > 0 ? frameRate.value : 30
    } catch {
      return 30
    }
  }

  private async collectItemTranscript(item: VideoClipTrackItem, seen: Set<string>, output: TranscriptSegment[]) {
    try {
      const projectItem = await item.getProjectItem()
      const clipItem = this.ppro.ClipProjectItem.cast(projectItem) as ClipProjectItem
      const json = await this.ppro.Transcript.exportToJSON(clipItem)
      if (!json) return
      const mediaPath = await clipItem.getMediaFilePath()
      const start = await item.getStartTime()
      const inPoint = await item.getInPoint()
      const key = `${mediaPath}:${start.seconds}:${inPoint.seconds}`
      if (seen.has(key)) return
      seen.add(key)
      output.push(...normalizeTranscriptJson(json, start.seconds - inPoint.seconds))
    } catch {
      // Graphics, adjustment layers, and unsupported project item types are skipped.
    }
  }

  async addMarkers(sequenceId: string, decisions: EditDecision[]): Promise<void> {
    void sequenceId
    const { project, sequence } = await this.context()
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
    void sequenceId
    const { project, sequence } = await this.context()
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
