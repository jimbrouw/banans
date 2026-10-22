import type {
  ClipProjectItem,
  CompoundAction,
  FrameRate,
  premierepro,
  Project,
  ProjectItem,
  Sequence,
  TickTime,
  VideoClipTrackItem,
} from '@adobe/premierepro'
import { MockPremiereAdapter } from './mockPremiere'
import { getRuntimeRequire, isPremiereHost } from './hostRuntime'
import { normalizeTranscriptJson, parseTranscriptFile } from './transcriptParse'
import {
  buildCutIntervals,
  buildDetectionFingerprint,
  classifyTrackForDetection,
  normalizeCutMap,
  selectTimelineSegmentsForIntervals,
  selectOutputTrack,
  validateDetectedSources,
} from './cutEngine'
import type { CameraSource, CutInterval, CutPoint, DetectedSources, TimelineSegment } from './cutEngine'
import { shotsToEnergyResetCuts } from './coldOpenAssembler'
import type { ColdOpenShot } from './coldOpenFinder'
import type { EditDecision, PremiereAdapter, SequenceInfo, SpeakerMapping, TranscriptSegment } from './types'
import { nextSequenceName, timeRange } from './sequenceNames'
import type { RunAction } from './sequenceNames'
import { fileInRoughCutBin } from './projectBin'

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

  async listSequences(): Promise<{ id: string; name: string }[]> {
    const project = await this.ppro.Project.getActiveProject()
    if (!project) return []
    return (await project.getSequences())
      .map((s) => ({ id: s.guid.toString(), name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }

  /** Open a sequence in the Timeline, making it Premiere's active sequence. */
  async activateSequence(id: string): Promise<void> {
    const project = await this.ppro.Project.getActiveProject()
    if (!project) throw new Error('Open a Premiere project before using RoughCut.')
    if (!await project.setActiveSequence(await this.findSequenceByGuid(project, id))) throw new Error('Premiere could not open that sequence.')
  }

  /** Call back whenever Premiere activates a sequence. Returns a function that stops listening. */
  watchActiveSequence(onChange: () => void): () => void {
    try {
      const event = this.ppro.Constants.SequenceEvent.ACTIVATED
      this.ppro.EventManager.addGlobalEventListener(event, onChange)
      return () => { try { this.ppro.EventManager.removeGlobalEventListener(event, onChange) } catch { /* already gone */ } }
    } catch {
      return () => {} // event not available in this Premiere build; the panel's polling still catches switches
    }
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
    // Premiere's scripting engine fails with large single transactions ("script object no longer valid").
    // Batch into chunks so each transaction stays well within limits.
    const BATCH = 20
    const markers = await this.ppro.Markers.getMarkers(sequence)
    for (let i = 0; i < decisions.length; i += BATCH) {
      const batch = decisions.slice(i, i + BATCH)
      const committed = this.tx(project, (compound) => {
        for (const decision of batch) {
          const start = this.ppro.TickTime.createWithSeconds(decision.start)
          const dur = this.ppro.TickTime.createWithSeconds(Math.max(0, (decision.end ?? decision.start) - decision.start))
          compound.addAction(markers.createAddMarkerAction(decision.label, markerType(decision), start, dur, `${decision.detail} | RoughCut confidence ${Math.round(decision.confidence * 100)}%`))
        }
      }, undoLabel)
      if (!committed) throw new Error(`Premiere rejected marker batch ${Math.floor(i / BATCH) + 1} of ${Math.ceil(decisions.length / BATCH)}.`)
    }
  }

  /** Give a generated sequence its numbered name and file it in the RoughCut bin. */
  private async nameGenerated(project: Project, item: ProjectItem, sourceName: string, action: RunAction, detail: string): Promise<string> {
    const name = nextSequenceName(sourceName, action, detail, (await project.getSequences()).map((s) => s.name))
    if (!this.tx(project, (c) => c.addAction(item.createSetNameAction(name)), `Name ${action} sequence`)) {
      throw new Error('Premiere created the sequence but could not rename it.')
    }
    await fileInRoughCutBin(this.ppro, project, item)
    return name
  }

  async createRoughCut(sequenceId: string, decisions: EditDecision[], mappings: SpeakerMapping[], run?: { action: RunAction; detail: string }): Promise<string> {
    void mappings
    void sequenceId
    const { project, sequence } = await this.context()
    const existingIds = new Set((await project.getSequences()).map((item) => item.guid.toString()))
    const cloned = this.tx(project, (compound) => compound.addAction(sequence.createCloneAction()), 'Create RoughCut sequence')
    if (!cloned) throw new Error('Premiere could not clone the active sequence.')
    const roughCut = (await project.getSequences()).find((item) => !existingIds.has(item.guid.toString()))
    if (!roughCut) throw new Error('Premiere cloned the sequence but did not return the new sequence.')
    const name = await this.nameGenerated(project, await roughCut.getProjectItem(), sequence.name, run?.action ?? 'Review Markers', run?.detail ?? `${decisions.length} markers`)
    await this.writeMarkers(project, roughCut, decisions, 'Add RoughCut markers')
    if (!await project.setActiveSequence(roughCut)) throw new Error('The rough cut was created, but Premiere could not open it.')
    return name
  }

  // ── Multi-cam auto-cut engine ─────────────────────────────────────────────

  private frameToTick(frame: number, fr: FrameRate): TickTime {
    return this.ppro.TickTime.createWithFrameAndFrameRate(frame, fr)
  }

  private tickToFrame(tt: TickTime, fr: FrameRate): number {
    return Math.round(tt.ticksNumber / fr.ticksPerFrame)
  }

  /**
   * Re-query a camera's source ClipProjectItem from a live sequence handle.
   * Premiere invalidates project-item handles fetched before a clone/remove
   * transaction (see BANANAS E4), so every post-transaction use must re-fetch.
   */
  private async freshSourceClip(sequence: Sequence, vIndex: number): Promise<ClipProjectItem> {
    const track = await sequence.getVideoTrack(vIndex)
    const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
    const projItem = await (items[0] as VideoClipTrackItem).getProjectItem()
    return this.ppro.ClipProjectItem.cast(projItem) as ClipProjectItem
  }

  /**
   * Re-fetch a live Sequence handle by guid. UXP invalidates Sequence objects
   * across each transaction (BANANAS E4); re-finding by stable guid right before
   * use guarantees the handle backing a create*Action call is current.
   */
  private async findSequenceByGuid(project: Project, guid: string): Promise<Sequence> {
    const seq = (await project.getSequences()).find(s => s.guid.toString() === guid)
    if (!seq) throw new Error('Sequence no longer exists. Re-detect before applying.')
    return seq
  }

  /**
   * Run an undoable transaction inside a locked-access scope. Premiere requires
   * every mutating executeTransaction to be wrapped in lockedAccess — outside the
   * lock, the sequence/clip handles referenced by the action are reported as
   * "script object is no longer valid". lockedAccess returns void, so the
   * transaction result is captured via closure.
   */
  private tx(
    project: Project,
    build: (compound: CompoundAction) => void,
    label: string,
  ): boolean {
    let ok = false
    project.lockedAccess(() => {
      ok = project.executeTransaction(build, label)
    })
    return ok
  }

  async detectSources(): Promise<DetectedSources> {
    const { sequence } = await this.context()
    const sequenceId = sequence.guid.toString()

    // Read the sequence's frame rate.
    const settings = await sequence.getSettings()
    const seqFrameRate = await settings.getVideoFrameRate()
    const frameRateValue = seqFrameRate.value > 0 ? seqFrameRate.value : 30
    const fr = this.ppro.FrameRate.createWithValue(frameRateValue)

    // Read total timeline length in frames.
    const endTime = await sequence.getEndTime()
    const totalFrames = this.tickToFrame(endTime, fr)

    const videoTrackCount = await sequence.getVideoTrackCount()
    const sources: CameraSource[] = []
    const trackItemCounts = new Map<number, number>()
    let multicamClipName = ''

    for (let v = 0; v < videoTrackCount; v++) {
      const track = await sequence.getVideoTrack(v)
      const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
      trackItemCounts.set(v, items.length)

      // Classify this track.
      let isSeq = false
      let isAdj = false
      if (items.length === 1) {
        const ti = items[0] as VideoClipTrackItem
        isAdj = await ti.isAdjustmentLayer()
        if (!isAdj) {
          try {
            const projItem = await ti.getProjectItem()
            const itemName = projItem.name
            const clip = this.ppro.ClipProjectItem.cast(projItem) as ClipProjectItem
            isSeq = await clip.isSequence()
            // Multicam source clips register as sequences and have [MCn] in their name.
            if (isSeq && /\[MC\d/i.test(itemName)) multicamClipName = itemName
          } catch {
            // If cast fails, treat as non-sequence (e.g. graphic).
          }
        }
      }

      const classification = classifyTrackForDetection(items.length, isSeq, isAdj)

      if (classification === 'end') break
      if (classification === 'skip') continue

      // classification === 'camera': read timing.
      const ti = items[0] as VideoClipTrackItem
      const projItem = await ti.getProjectItem()
      const clip = this.ppro.ClipProjectItem.cast(projItem) as ClipProjectItem
      const mediaPath = await clip.getMediaFilePath()

      const startTime = await ti.getStartTime()
      const inPoint = await ti.getInPoint()
      const outPoint = await ti.getOutPoint()

      sources.push({
        vIndex: v,
        camera: sources.length + 1,
        name: projItem.name,
        mediaPath,
        clipStartFrame: this.tickToFrame(startTime, fr),
        clipInFrame: this.tickToFrame(inPoint, fr),
        clipOutFrame: this.tickToFrame(outPoint, fr),
      })
    }

    const targetTrackIndex = selectOutputTrack(
      sources,
      videoTrackCount,
      (v) => trackItemCounts.get(v) ?? 0,
    )

    if (sources.length < 2 && multicamClipName) {
      throw new Error(
        `This sequence contains a Multicam Source Clip ("${multicamClipName}") — Auto-Cut needs individual camera tracks, not a merged multicam clip.\n\n` +
        `To fix: open the original multi-camera source sequence where each camera is on its own video track (V1 = Camera 1, V2 = Camera 2, etc.), then run Detect Cameras from there.`
      )
    }

    validateDetectedSources(sources, targetTrackIndex)

    const targetTrackItemCount = trackItemCounts.get(targetTrackIndex) ?? 0
    const fingerprint = buildDetectionFingerprint(
      sequenceId, frameRateValue, totalFrames,
      targetTrackIndex, targetTrackItemCount, sources,
    )

    return {
      sequenceId,
      fingerprint,
      sources,
      targetTrackIndex,
      totalFrames,
      frameRate: frameRateValue,
    }
  }

  async applyCutMap(
    sequenceId: string,
    cuts: CutPoint[],
    det: DetectedSources,
    endFrame: number,
    detail = '',
  ): Promise<string> {
    let phase = 'init'
    try {
      // 1. Validate sequence identity.
      phase = 'fetch active project/sequence'
      let { project, sequence } = await this.context()
      const activeId = sequence.guid.toString()
      if (activeId !== sequenceId) {
        throw new Error('Active sequence changed. Re-detect before applying.')
      }
      if (sequenceId !== det.sequenceId) {
        throw new Error('Detection was for a different sequence. Re-detect before applying.')
      }

      const fr = this.ppro.FrameRate.createWithValue(det.frameRate)
      const toTick = (frame: number) => this.frameToTick(frame, fr)

      // 2. Re-detect and verify fingerprint. Resolve host objects by track index.
      phase = 'verify camera tracks'
      const clipMap = new Map<number, ClipProjectItem>()
      for (const src of det.sources) {
        const track = await sequence.getVideoTrack(src.vIndex)
        const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
        if (items.length !== 1) {
          throw new Error(
            `Timeline changed: V${src.vIndex + 1} now has ${items.length} clips (expected 1). Re-detect before applying.`,
          )
        }
        const ti = items[0] as VideoClipTrackItem
        const projItem = await ti.getProjectItem()
        const clip = this.ppro.ClipProjectItem.cast(projItem) as ClipProjectItem

        // Verify media path matches.
        const currentPath = await clip.getMediaFilePath()
        if (currentPath !== src.mediaPath) {
          throw new Error(
            `Timeline changed: V${src.vIndex + 1} media path changed. Re-detect before applying.`,
          )
        }

        // Verify timing matches.
        const startFrame = this.tickToFrame(await ti.getStartTime(), fr)
        const inFrame = this.tickToFrame(await ti.getInPoint(), fr)
        const outFrame = this.tickToFrame(await ti.getOutPoint(), fr)
        if (startFrame !== src.clipStartFrame || inFrame !== src.clipInFrame || outFrame !== src.clipOutFrame) {
          throw new Error(
            `Timeline changed: V${src.vIndex + 1} timing differs from detection. Re-detect before applying.`,
          )
        }

        clipMap.set(src.camera, clip)
      }

      // Verify target track item count.
      phase = 'fingerprint check'
      const targetTrack = await sequence.getVideoTrack(det.targetTrackIndex).catch(() => null)
      const targetItems = targetTrack
        ? await targetTrack.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
        : []
      const currentFingerprint = buildDetectionFingerprint(
        sequenceId, det.frameRate, det.totalFrames,
        det.targetTrackIndex, targetItems.length, det.sources,
      )
      if (currentFingerprint !== det.fingerprint) {
        throw new Error('Timeline changed since detection. Re-detect before applying.')
      }

      // 3. Normalize and validate cuts.
      const normalized = normalizeCutMap(cuts, endFrame, det.sources.length)

      // 4. Build intervals (validates coverage — rejects on any gap).
      const intervals = buildCutIntervals(normalized, endFrame, det.sources)

      // 5. Save original in/out points as raw tick strings.
      // Storing TickTime objects would also go stale across the clone; the string
      // is plain data that rebuilds an exact handle later via createWithTicks.
      phase = 'save original in/out'
      const savedState = new Map<number, { inTicks: string; outTicks: string }>()
      for (const [cam, clip] of clipMap) {
        const inP = await clip.getInPoint(this.ppro.Constants.MediaType.VIDEO)
        const outP = await clip.getOutPoint(this.ppro.Constants.MediaType.VIDEO)
        savedState.set(cam, { inTicks: inP.ticks, outTicks: outP.ticks })
      }

      // 6. Clone sequence.
      // Snapshot existing sequence guids FIRST: any await between fetching the
      // `sequence` handle and using it in createCloneAction() invalidates it
      // (BANANAS E4). The fetch of `sequence` must be the last await before the
      // clone transaction, with only synchronous work in between.
      phase = 'clone sequence'
      const beforeGuids = new Set((await project.getSequences()).map(s => s.guid.toString()))
      ;({ project, sequence } = await this.context())
      if (sequence.guid.toString() !== sequenceId) throw new Error('Active sequence changed. Re-detect before applying.')
      const cloneOk = this.tx(
        project,
        (c) => c.addAction(sequence.createCloneAction()),
        'RoughCut auto-cut clone',
      )
      if (!cloneOk) throw new Error('Premiere rejected the clone transaction.')

      const cloneRef = (await project.getSequences()).find(s => !beforeGuids.has(s.guid.toString()))
      if (!cloneRef) throw new Error('Clone completed but new sequence not found.')
      const cloneId = cloneRef.guid.toString()

      // Rename the clone.
      phase = 'rename clone'
      const cloneName = await this.nameGenerated(project, await cloneRef.getProjectItem(), sequence.name, 'Auto Cut', detail)

      // 7. Build the switched cut by camera-disable, keeping every angle on its
      //    own track. There is no programmatic razor, so for multi-segment cuts we
      //    blade each camera track at the cut points by overwriting that camera's
      //    OWN footage per interval (visually identical, but splits the clip).
      //    With a single segment no blade is needed — the whole clip is the segment.
      const coversInterval = (src: CameraSource, iv: { startFrame: number; endFrame: number }) => {
        const kIn = iv.startFrame - src.clipStartFrame + src.clipInFrame
        const kOut = iv.endFrame - src.clipStartFrame + src.clipInFrame
        return kIn >= src.clipInFrame && kOut <= src.clipOutFrame
      }
      const needsBlade = intervals.length > 1
      let bladed = false
      const restoreFailures: string[] = []
      try {
        // Cache live handles once. lockedAccess keeps them valid across transactions
        // (the reuse pattern the working Vibe-splice spike relies on), so a dense cut
        // avoids thousands of getSequences()/getEditor() round-trips. camClip and
        // camItem are the SAME underlying bin item — one cast for setInOut, one raw
        // ProjectItem for the overwrite.
        phase = 'prepare clone editor + sources'
        const cloneSeq = await this.findSequenceByGuid(project, cloneId)
        const editor = await this.ppro.SequenceEditor.getEditor(cloneSeq)
        const origSeq = await this.findSequenceByGuid(project, sequenceId)
        const camItem = new Map<number, ProjectItem>()
        const camClip = new Map<number, ClipProjectItem>()
        for (const src of det.sources) {
          const track = await origSeq.getVideoTrack(src.vIndex)
          const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
          const pi = await (items[0] as VideoClipTrackItem).getProjectItem()
          camItem.set(src.camera, pi)
          camClip.set(src.camera, this.ppro.ClipProjectItem.cast(pi) as ClipProjectItem)
        }

        if (needsBlade) {
          for (const src of det.sources) {
            const clip = camClip.get(src.camera)!
            const projItem = camItem.get(src.camera)!
            for (const iv of intervals) {
              if (!coversInterval(src, iv)) continue
              const kIn = iv.startFrame - src.clipStartFrame + src.clipInFrame
              const kOut = iv.endFrame - src.clipStartFrame + src.clipInFrame
              phase = `blade cam${src.camera} @${iv.startFrame}`
              const setOk = this.tx(
                project,
                (c) => c.addAction(clip.createSetInOutPointsAction(toTick(kIn), toTick(kOut))),
                `Set in/out cam${src.camera}`,
              )
              if (!setOk) throw new Error(`Premiere rejected in/out for camera ${src.camera}.`)
              bladed = true
              const writeOk = this.tx(
                project,
                (c) => c.addAction(editor.createOverwriteItemAction(projItem, toTick(iv.startFrame), src.vIndex, -1)),
                `Blade cam${src.camera} @${iv.startFrame}`,
              )
              if (!writeOk) throw new Error(`Premiere rejected blade for camera ${src.camera} at frame ${iv.startFrame}.`)
            }
          }
        }

        // Disable every non-focus segment. Read each track's items once, map them by
        // start frame, then disable in compound batches (one transaction per batch,
        // kept small so a single transaction never grows too large).
        for (const src of det.sources) {
          const toDisable = intervals.filter((iv) => iv.camera !== src.camera && coversInterval(src, iv))
          if (toDisable.length === 0) continue
          phase = `disable cam${src.camera}`
          const track = await cloneSeq.getVideoTrack(src.vIndex)
          const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
          const segments: TimelineSegment<VideoClipTrackItem>[] = []
          for (const item of items) {
            const it = item as VideoClipTrackItem
            segments.push({
              startFrame: this.tickToFrame(await it.getStartTime(), fr),
              endFrame: this.tickToFrame(await it.getEndTime(), fr),
              item: it,
            })
          }
          let targets: VideoClipTrackItem[]
          try {
            targets = selectTimelineSegmentsForIntervals(segments, toDisable)
          } catch (e) {
            throw new Error(
              `Camera ${src.camera} on V${src.vIndex + 1}: ${e instanceof Error ? e.message : String(e)}`,
              { cause: e },
            )
          }
          const BATCH = 20
          for (let i = 0; i < targets.length; i += BATCH) {
            const chunk = targets.slice(i, i + BATCH)
            phase = `disable cam${src.camera} batch ${Math.floor(i / BATCH) + 1}`
            const ok = this.tx(
              project,
              (c) => { for (const it of chunk) c.addAction(it.createSetDisabledAction(true)) },
              `Disable cam${src.camera} ${i}`,
            )
            if (!ok) throw new Error(`Premiere rejected disable batch for camera ${src.camera}.`)
          }
        }
      } finally {
        // 8. Restore source in/out points — only if blading mutated them.
        if (bladed) {
          phase = 'restore source in/out'
          const rp = await this.ppro.Project.getActiveProject()
          if (rp) {
            const rs = await this.findSequenceByGuid(rp, sequenceId)
            for (const src of det.sources) {
              const saved = savedState.get(src.camera)
              if (!saved) continue
              try {
                const freshClip = await this.freshSourceClip(rs, src.vIndex)
                const ok = this.tx(
                  rp,
                  (c) => c.addAction(freshClip.createSetInOutPointsAction(
                    this.ppro.TickTime.createWithTicks(saved.inTicks),
                    this.ppro.TickTime.createWithTicks(saved.outTicks),
                  )),
                  `Restore in/out cam${src.camera}`,
                )
                if (!ok) restoreFailures.push(`Camera ${src.camera}: transaction rejected`)
              } catch (e) {
                restoreFailures.push(`Camera ${src.camera}: ${e instanceof Error ? e.message : String(e)}`)
              }
            }
          }
        }
      }
      if (restoreFailures.length > 0) {
        throw new Error(
          `Auto-cut FAILED: could not restore original source in/out points.\n` +
          `Affected cameras:\n${restoreFailures.map(f => `  • ${f}`).join('\n')}\n` +
          `Check these clips in the Source Monitor and reset their in/out points manually.`,
        )
      }

      // 9. Activate the clone.
      phase = 'activate clone'
      await project.setActiveSequence(await this.findSequenceByGuid(project, cloneId))

      return cloneName
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/script object is no longer valid/i.test(msg)) {
        throw new Error(`[${phase}] ${msg}`, { cause: e })
      }
      throw e
    }
  }

  async assembleSocialSequence(
    sequenceId: string,
    decisions: EditDecision[],
    mappings: SpeakerMapping[],
    det: DetectedSources
  ): Promise<string> {
    let { project, sequence } = await this.context()
    const activeId = sequence.guid.toString()
    if (activeId !== sequenceId) {
      throw new Error('Active sequence changed. Re-detect before applying.')
    }

    const fr = this.ppro.FrameRate.createWithValue(det.frameRate)
    const toTick = (frame: number) => this.frameToTick(frame, fr)

    // 1. Resolve host clip objects by camera index
    const clipMap = new Map<number, ClipProjectItem>()
    for (const src of det.sources) {
      const track = await sequence.getVideoTrack(src.vIndex)
      const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
      if (items.length !== 1) {
        throw new Error(`Timeline changed. Re-detect before applying.`)
      }
      const ti = items[0] as VideoClipTrackItem
      const projItem = await ti.getProjectItem()
      clipMap.set(src.camera, this.ppro.ClipProjectItem.cast(projItem) as ClipProjectItem)
    }

    // 2. Save original in/out points as raw tick strings (plain data survives the clone).
    const savedState = new Map<number, { inTicks: string; outTicks: string }>()
    for (const [cam, clip] of clipMap) {
      const inP = await clip.getInPoint(this.ppro.Constants.MediaType.VIDEO)
      const outP = await clip.getOutPoint(this.ppro.Constants.MediaType.VIDEO)
      savedState.set(cam, { inTicks: inP.ticks, outTicks: outP.ticks })
    }

    // 3. Clone sequence. Snapshot guids FIRST: the `sequence` fetch must be the
    // last await before createCloneAction(), or the handle stales (BANANAS E4).
    const beforeGuids = new Set((await project.getSequences()).map(s => s.guid.toString()))
    ;({ project, sequence } = await this.context())
    if (sequence.guid.toString() !== sequenceId) throw new Error('Active sequence changed. Re-detect before applying.')
    const cloneOk = this.tx(
      project,
      (c) => c.addAction(sequence.createCloneAction()),
      'RoughCut cold open clone',
    )
    if (!cloneOk) throw new Error('Premiere rejected the clone transaction.')

    const clone = (await project.getSequences()).find(s => !beforeGuids.has(s.guid.toString()))
    if (!clone) throw new Error('Clone completed but new sequence not found.')

    // 4. Name the clone and file it in the RoughCut bin
    const cloneName = await this.nameGenerated(project, await clone.getProjectItem(), sequence.name, 'Social Cut', `${decisions.length} clips`)

    // 5. Clear target track on clone
    const editor = await this.ppro.SequenceEditor.getEditor(clone)
    if (det.targetTrackIndex < await clone.getVideoTrackCount()) {
      const cloneTargetTrack = await clone.getVideoTrack(det.targetTrackIndex)
      const existingItems = await cloneTargetTrack.getTrackItems(
        this.ppro.Constants.TrackItemType.CLIP, false,
      )
      if (existingItems.length > 0) {
        let clearSelection: Awaited<ReturnType<typeof clone.getSelection>> | null = null
        this.ppro.TrackItemSelection.createEmptySelection((sel) => { clearSelection = sel })
        if (!clearSelection) clearSelection = await clone.getSelection()
        for (const item of existingItems) clearSelection!.addItem(item as VideoClipTrackItem)
        this.tx(
          project,
          (c) => c.addAction(editor.createRemoveItemsAction(
            clearSelection!, false, this.ppro.Constants.MediaType.VIDEO, false,
          )),
          'Clear target track',
        )
      }
    }

    const { resolveCameraNum } = await import('./autopilot')

    const speakerToCamera = (speaker: string) => {
      const m = mappings.find(item => item.speaker === speaker)
      const sourcesList = det.sources.map(s => ({ camera: s.camera, name: s.name }))
      const targetName = m ? m.camera : 'Wide'
      return resolveCameraNum(targetName, sourcesList)
    }

    // 6. Write clips sequentially.
    // Re-fetch context — the clone/rename/clear transactions above stale the
    // project and sequence handles (BANANAS E4).
    ;({ project, sequence } = await this.context())
    if (sequence.guid.toString() !== sequenceId) throw new Error('Active sequence changed. Re-detect before applying.')

    // Pre-compute the insert-vs-overwrite decision — getVideoTrackCount() is async
    // and cannot be awaited inside the synchronous lockedAccess callback.
    const cloneTrackCount = await clone.getVideoTrackCount()
    const useInsertForFirstClip = det.targetTrackIndex >= cloneTrackCount

    const restoreFailures: string[] = []
    try {
      let currentStartFrame = 0
      let isFirstClip = true

      for (const dec of decisions) {
        // Parse speaker out of inquisitive hook label: e.g. "Inquisitive hook (Host)"
        const match = dec.label.match(/\(([^)]+)\)/)
        const speakerName = match ? match[1] : 'Wide'
        const camNum = speakerToCamera(speakerName)

        const srcInfo = det.sources.find(s => s.camera === camNum)!

        // Map timeline seconds to frames
        const startFrame = Math.round(dec.start * det.frameRate)
        const endFrame = Math.round((dec.end ?? dec.start) * det.frameRate)
        const duration = endFrame - startFrame
        if (duration <= 0) continue

        // Convert to source media frames
        // sourceFrame = timelineFrame - clipStartFrame + clipInFrame
        const sourceInFrame = startFrame - srcInfo.clipStartFrame + srcInfo.clipInFrame
        const sourceOutFrame = endFrame - srcInfo.clipStartFrame + srcInfo.clipInFrame

        // Re-query the source clip fresh; one live handle for both in/out and overwrite.
        const srcTrack = await sequence.getVideoTrack(srcInfo.vIndex)
        const srcItems = await srcTrack.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
        const projItem = await (srcItems[0] as VideoClipTrackItem).getProjectItem()
        const clip = this.ppro.ClipProjectItem.cast(projItem) as ClipProjectItem

        // Set source in/out
        const setOk = this.tx(
          project,
          (c) => c.addAction(clip.createSetInOutPointsAction(
            toTick(sourceInFrame),
            toTick(sourceOutFrame),
          )),
          `Set hook in/out cam${camNum}`,
        )
        if (!setOk) throw new Error(`Premiere rejected in/out for camera ${camNum}.`)

        if (isFirstClip && useInsertForFirstClip) {
          this.tx(
            project,
            (c) => c.addAction(editor.createInsertProjectItemAction(
              projItem, toTick(currentStartFrame), det.targetTrackIndex, -1, true,
            )),
            `Insert hook cam${camNum} @${currentStartFrame}`,
          )
        } else {
          this.tx(
            project,
            (c) => c.addAction(editor.createOverwriteItemAction(
              projItem, toTick(currentStartFrame), det.targetTrackIndex, -1,
            )),
            `Overwrite hook cam${camNum} @${currentStartFrame}`,
          )
        }
        isFirstClip = false

        currentStartFrame += duration
      }
    } finally {
      // 7. Restore source in/out points with re-fetched context and fresh handles.
      const { project: rp, sequence: rs } = await this.context()
      for (const src of det.sources) {
        const saved = savedState.get(src.camera)
        if (!saved) continue
        try {
          const freshClip = await this.freshSourceClip(rs, src.vIndex)
          const ok = this.tx(
            rp,
            (c) => c.addAction(freshClip.createSetInOutPointsAction(
              this.ppro.TickTime.createWithTicks(saved.inTicks),
              this.ppro.TickTime.createWithTicks(saved.outTicks),
            )),
            `Restore in/out cam${src.camera}`,
          )
          if (!ok) restoreFailures.push(`Camera ${src.camera}: transaction rejected`)
        } catch (e) {
          restoreFailures.push(`Camera ${src.camera}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    if (restoreFailures.length > 0) {
      throw new Error(
        `Auto-cut FAILED: could not restore original source in/out points.\n` +
        `Affected cameras:\n${restoreFailures.map(f => `  • ${f}`).join('\n')}\n` +
        `Check these clips in the Source Monitor and reset their in/out points manually.`,
      )
    }

    // 8. Activate the clone
    await project.setActiveSequence(clone)

    return cloneName
  }

  /**
   * Assemble a cold-open clip from [startSeconds, endSeconds] as a new subsequence.
   * createSubsequence(true) carries every video AND audio track for the in/out range,
   * giving a self-contained clip with synced audio.
   *
   * When `shots` is supplied, the Energy Reset multi-cam cut list is applied to the
   * subsequence IN PLACE: cameras are detected on the subsequence itself (so frame
   * data is correct), the shots become a cut map, and each interval is left showing
   * only its focus camera (blade + disable). If detection or cutting fails the flat
   * clip is still returned — the cold open always exists.
   */
  async assembleColdOpenClip(
    sequenceId: string,
    startSeconds: number,
    endSeconds: number,
    shots?: ColdOpenShot[],
  ): Promise<string> {
    let { project, sequence } = await this.context()
    if (sequence.guid.toString() !== sequenceId) {
      throw new Error('Active sequence changed. Re-open the source sequence before assembling.')
    }
    if (!(endSeconds > startSeconds)) throw new Error('Cold open end must be after its start.')

    // Set the sequence in/out to the hook range.
    const inT = this.ppro.TickTime.createWithSeconds(startSeconds)
    const outT = this.ppro.TickTime.createWithSeconds(endSeconds)
    const setOk = this.tx(
      project,
      (c) => {
        c.addAction(sequence.createSetInPointAction(inT))
        c.addAction(sequence.createSetOutPointAction(outT))
      },
      'RoughCut cold open in/out',
    )
    if (!setOk) throw new Error('Premiere rejected setting the cold open in/out points.')

    // Re-fetch the sequence (the set-in/out transaction stales the handle), then
    // make a subsequence of the in/out range across all tracks.
    ;({ project, sequence } = await this.context())
    const sub = await sequence.createSubsequence(true)
    if (!sub) throw new Error('Premiere could not create the cold open subsequence.')

    const name = await this.nameGenerated(project, await sub.getProjectItem(), sequence.name, 'Cold Open', timeRange(startSeconds, endSeconds))

    // Activate the subsequence so detection + cutting target it.
    const subId = sub.guid.toString()
    await project.setActiveSequence(await this.findSequenceByGuid(project, subId))

    // No shot plan → flat lift, done.
    if (!shots || shots.length === 0) return name

    // Energy Reset: detect cameras ON THE SUBSEQUENCE (correct 0-based frame data),
    // turn the shot plan into a cut map, and apply it in place.
    try {
      const subDet = await this.detectSources()
      if (subDet.sources.length < 2) return name   // single-cam window — nothing to switch

      const windowSeconds = endSeconds - startSeconds
      const cuts = shotsToEnergyResetCuts(shots, windowSeconds, subDet.sources, subDet.frameRate)
      if (new Set(cuts.map((c) => c.camera)).size < 2) return name   // one angle → nothing to switch

      const fr = this.ppro.FrameRate.createWithValue(subDet.frameRate)
      const endFrame = subDet.totalFrames
      const normalized = normalizeCutMap(cuts, endFrame, subDet.sources.length)
      const intervals = buildCutIntervals(normalized, endFrame, subDet.sources)

      const rp = await this.ppro.Project.getActiveProject()
      if (!rp) return name
      await this.bladeAndDisableInPlace(rp, subId, intervals, subDet.sources, fr)

      // Phase 2: Digital punch-ins — scale 100→103% on marked shots.
      // Silently skip per-shot if keyframing fails (Probe A gates this at runtime).
      try {
        await this.applyPunchIns(rp, subId, shots, cuts, subDet.sources, fr, subDet.frameRate)
      } catch {
        // Non-fatal: punch-ins are enhancement, not core.
      }

      // Phase 3: J/L split edits — audio leads/trails at cut points.
      // Silently skip if audio access fails (Probe B gates this at runtime).
      try {
        await this.applySplitEdits(rp, subId, shots, cuts, fr, subDet.frameRate)
      } catch {
        // Non-fatal: split edits are enhancement.
      }

      return name
    } catch (e) {
      // Camera switching failed — the flat clip with synced audio still exists.
      return `${name} — flat (multicam switch skipped: ${e instanceof Error ? e.message : String(e)})`
    }
  }

  /**
   * Apply an Energy-Reset camera switch to a sequence IN PLACE (no clone). The
   * sequence must have each camera on its own video track with one clip per track —
   * true for a createSubsequence(true) cold open whose source was a multi-cam stack.
   * Each interval is left showing only its focus camera (others bladed + disabled).
   * Source bin in/out points are saved and restored, since blading mutates them.
   *
   * Mirrors applyCutMap's proven blade+disable core, minus the clone/fingerprint
   * machinery (we just created this sequence, so there is nothing to guard against).
   */
  private async bladeAndDisableInPlace(
    project: Project,
    seqId: string,
    intervals: CutInterval[],
    sources: CameraSource[],
    fr: FrameRate,
  ): Promise<void> {
    const toTick = (frame: number) => this.frameToTick(frame, fr)
    const coversInterval = (src: CameraSource, iv: { startFrame: number; endFrame: number }) => {
      const kIn = iv.startFrame - src.clipStartFrame + src.clipInFrame
      const kOut = iv.endFrame - src.clipStartFrame + src.clipInFrame
      return kIn >= src.clipInFrame && kOut <= src.clipOutFrame
    }
    const needsBlade = intervals.length > 1
    let bladed = false

    // Save source bin in/out points (blading overwrites them).
    const seq0 = await this.findSequenceByGuid(project, seqId)
    const savedState = new Map<number, { inTicks: string; outTicks: string }>()
    for (const src of sources) {
      const clip = await this.freshSourceClip(seq0, src.vIndex)
      const inP = await clip.getInPoint(this.ppro.Constants.MediaType.VIDEO)
      const outP = await clip.getOutPoint(this.ppro.Constants.MediaType.VIDEO)
      savedState.set(src.camera, { inTicks: inP.ticks, outTicks: outP.ticks })
    }

    try {
      const seq = await this.findSequenceByGuid(project, seqId)
      const editor = await this.ppro.SequenceEditor.getEditor(seq)
      const camItem = new Map<number, ProjectItem>()
      const camClip = new Map<number, ClipProjectItem>()
      for (const src of sources) {
        const track = await seq.getVideoTrack(src.vIndex)
        const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
        const pi = await (items[0] as VideoClipTrackItem).getProjectItem()
        camItem.set(src.camera, pi)
        camClip.set(src.camera, this.ppro.ClipProjectItem.cast(pi) as ClipProjectItem)
      }

      // Blade every camera at every interval boundary it covers, so all tracks
      // share aligned segments for the disable pass.
      if (needsBlade) {
        for (const src of sources) {
          const clip = camClip.get(src.camera)!
          const projItem = camItem.get(src.camera)!
          for (const iv of intervals) {
            if (!coversInterval(src, iv)) continue
            const kIn = iv.startFrame - src.clipStartFrame + src.clipInFrame
            const kOut = iv.endFrame - src.clipStartFrame + src.clipInFrame
            const setOk = this.tx(
              project,
              (c) => c.addAction(clip.createSetInOutPointsAction(toTick(kIn), toTick(kOut))),
              `Set in/out cam${src.camera}`,
            )
            if (!setOk) throw new Error(`Premiere rejected in/out for camera ${src.camera}.`)
            bladed = true
            const writeOk = this.tx(
              project,
              (c) => c.addAction(editor.createOverwriteItemAction(projItem, toTick(iv.startFrame), src.vIndex, -1)),
              `Blade cam${src.camera} @${iv.startFrame}`,
            )
            if (!writeOk) throw new Error(`Premiere rejected blade for camera ${src.camera} at frame ${iv.startFrame}.`)
          }
        }
      }

      // Disable every non-focus segment.
      for (const src of sources) {
        const toDisable = intervals.filter((iv) => iv.camera !== src.camera && coversInterval(src, iv))
        if (toDisable.length === 0) continue
        const track = await seq.getVideoTrack(src.vIndex)
        const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
        const segments: TimelineSegment<VideoClipTrackItem>[] = []
        for (const item of items) {
          const it = item as VideoClipTrackItem
          segments.push({
            startFrame: this.tickToFrame(await it.getStartTime(), fr),
            endFrame: this.tickToFrame(await it.getEndTime(), fr),
            item: it,
          })
        }
        let targets: VideoClipTrackItem[]
        try {
          targets = selectTimelineSegmentsForIntervals(segments, toDisable)
        } catch (e) {
          throw new Error(
            `Camera ${src.camera} on V${src.vIndex + 1}: ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          )
        }
        const BATCH = 20
        for (let i = 0; i < targets.length; i += BATCH) {
          const chunk = targets.slice(i, i + BATCH)
          const ok = this.tx(
            project,
            (c) => { for (const it of chunk) c.addAction(it.createSetDisabledAction(true)) },
            `Disable cam${src.camera} ${i}`,
          )
          if (!ok) throw new Error(`Premiere rejected disable batch for camera ${src.camera}.`)
        }
      }
    } finally {
      // Restore source bin in/out points (best effort) if blading changed them.
      if (bladed) {
        const rp = await this.ppro.Project.getActiveProject()
        if (rp) {
          const rs = await this.findSequenceByGuid(rp, seqId)
          for (const src of sources) {
            const saved = savedState.get(src.camera)
            if (!saved) continue
            try {
              const freshClip = await this.freshSourceClip(rs, src.vIndex)
              this.tx(
                rp,
                (c) => c.addAction(freshClip.createSetInOutPointsAction(
                  this.ppro.TickTime.createWithTicks(saved.inTicks),
                  this.ppro.TickTime.createWithTicks(saved.outTicks),
                )),
                `Restore in/out cam${src.camera}`,
              )
            } catch {
              // Best-effort restore; leave it to the editor if Premiere rejects.
            }
          }
        }
      }
    }
  }

  /**
   * Phase 2 — Digital punch-ins. For each shot marked `punch: true`, find the
   * video clip in the subsequence that corresponds to that interval and keyframe
   * its Motion > Scale from 100% to 103% across the clip duration. This creates
   * a subtle creep-in zoom that draws the eye without being jarring.
   *
   * Gated at runtime by Phase 0 Probe A (scale keyframing). If the Motion
   * component or Scale param isn't accessible, the method throws and the caller
   * silently eats the error — the clip is still cut and usable.
   */
  private async applyPunchIns(
    project: Project,
    seqId: string,
    shots: ColdOpenShot[],
    cuts: CutPoint[],
    sources: CameraSource[],
    fr: FrameRate,
    frameRate: number,
  ): Promise<void> {
    const punchShots = shots.filter((s) => s.punch)
    if (!punchShots.length) return

    const seq = await this.findSequenceByGuid(project, seqId)
    for (const shot of punchShots) {
      // Find the cut point that corresponds to this shot.
      const shotFrameApprox = Math.round(shot.offsetSeconds * frameRate)
      const matchingCut = cuts.find((c) => Math.abs(c.frame - shotFrameApprox) < frameRate)
      if (!matchingCut) continue

      // Find the source for this camera.
      const src = sources.find((s) => s.camera === matchingCut.camera)
      if (!src) continue

      const track = await seq.getVideoTrack(src.vIndex)
      const items = await track.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
      // Find the clip that starts at (approximately) this cut's frame.
      let targetItem: VideoClipTrackItem | null = null
      for (const it of items) {
        const startFrame = this.tickToFrame(await it.getStartTime(), fr)
        if (Math.abs(startFrame - matchingCut.frame) < 3) {
          targetItem = it as VideoClipTrackItem
          break
        }
      }
      if (!targetItem) continue

      // Get the Motion component and Scale param.
      const chain = await targetItem.getComponentChain()
      const compCount = chain.getComponentCount()
      let scaleParam = null
      for (let ci = 0; ci < compCount; ci++) {
        const comp = chain.getComponentAtIndex(ci)
        const matchName = await comp.getMatchName()
        if (!matchName.includes('Motion') && !matchName.includes('ADBE Motion')) continue
        const paramCount = comp.getParamCount()
        for (let pi = 0; pi < paramCount; pi++) {
          const param = comp.getParam(pi)
          if (param.displayName.toLowerCase().includes('scale')) {
            scaleParam = param
            break
          }
        }
        if (scaleParam) break
      }
      if (!scaleParam) continue

      const clipStartTick = await targetItem.getStartTime()
      const clipEndTick = await targetItem.getEndTime()
      const kfStart = scaleParam.createKeyframe(100)
      kfStart.position = clipStartTick
      const kfEnd = scaleParam.createKeyframe(103)
      kfEnd.position = clipEndTick

      this.tx(
        project,
        (c) => {
          c.addAction(scaleParam!.createSetTimeVaryingAction(true))
          c.addAction(scaleParam!.createAddKeyframeAction(kfStart))
          c.addAction(scaleParam!.createAddKeyframeAction(kfEnd))
        },
        `Punch-in scale cam${src.camera}`,
      )
    }
  }

  /**
   * Phase 3 — J/L split edits. For shots with jCutSeconds > 0, offset the
   * corresponding audio clip's in-point earlier so audio leads video (J-cut).
   * For shots with lCutSeconds > 0, extend the audio clip's out-point past the
   * video cut so audio trails into the next angle (L-cut).
   *
   * Gated at runtime by Phase 0 Probe B (audio track item access). Throws on
   * failure; caller silently eats the error.
   */
  private async applySplitEdits(
    project: Project,
    seqId: string,
    shots: ColdOpenShot[],
    cuts: CutPoint[],
    fr: FrameRate,
    frameRate: number,
  ): Promise<void> {
    const splitShots = shots.filter((s) => (s.jCutSeconds ?? 0) > 0 || (s.lCutSeconds ?? 0) > 0)
    if (!splitShots.length) return

    const seq = await this.findSequenceByGuid(project, seqId)
    const audioTrackCount = await seq.getAudioTrackCount()
    if (!audioTrackCount) return

    // We only touch the primary audio track (A1 = index 0) which carries the
    // mix — J/L on the mix track is enough to create the overlap feel.
    const a1 = await seq.getAudioTrack(0)
    const audioItems = await a1.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)

    for (const shot of splitShots) {
      const jSec = shot.jCutSeconds ?? 0
      const lSec = shot.lCutSeconds ?? 0
      const shotFrameApprox = Math.round(shot.offsetSeconds * frameRate)
      const matchingCut = cuts.find((c) => Math.abs(c.frame - shotFrameApprox) < frameRate)
      if (!matchingCut) continue

      // Find the audio item whose start time aligns with this cut.
      let targetAudio = null
      for (const ai of audioItems) {
        const startFrame = this.tickToFrame(await ai.getStartTime(), fr)
        if (Math.abs(startFrame - matchingCut.frame) < 5) {
          targetAudio = ai
          break
        }
      }
      if (!targetAudio) continue

      if (jSec > 0) {
        const currentIn = await targetAudio.getInPoint()
        const newInSeconds = Math.max(0, currentIn.seconds - jSec)
        const newInTick = this.ppro.TickTime.createWithSeconds(newInSeconds)
        this.tx(
          project,
          (c) => c.addAction(targetAudio!.createSetInPointAction(newInTick)),
          'J-cut audio lead',
        )
      }

      if (lSec > 0) {
        const currentOut = await targetAudio.getOutPoint()
        const newOutTick = this.ppro.TickTime.createWithSeconds(currentOut.seconds + lSec)
        this.tx(
          project,
          (c) => c.addAction(targetAudio!.createSetOutPointAction(newOutTick)),
          'L-cut audio trail',
        )
      }
    }
  }
}

export function createPremiereAdapter(): PremiereAdapter {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return new MockPremiereAdapter()
  return new UxpPremiereAdapter(runtimeRequire('premierepro') as premierepro)
}

export const premiere = createPremiereAdapter()
export { isPremiereHost }
