import type {
  ClipProjectItem,
  FrameRate,
  premierepro,
  Project,
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
  selectOutputTrack,
  validateDetectedSources,
} from './cutEngine'
import type { CameraSource, CutPoint, DetectedSources } from './cutEngine'
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
    // Premiere's scripting engine fails with large single transactions ("script object no longer valid").
    // Batch into chunks so each transaction stays well within limits.
    const BATCH = 20
    const markers = await this.ppro.Markers.getMarkers(sequence)
    for (let i = 0; i < decisions.length; i += BATCH) {
      const batch = decisions.slice(i, i + BATCH)
      const committed = project.executeTransaction((compound) => {
        for (const decision of batch) {
          const start = this.ppro.TickTime.createWithSeconds(decision.start)
          const dur = this.ppro.TickTime.createWithSeconds(Math.max(0, (decision.end ?? decision.start) - decision.start))
          compound.addAction(markers.createAddMarkerAction(decision.label, markerType(decision), start, dur, `${decision.detail} | RoughCut confidence ${Math.round(decision.confidence * 100)}%`))
        }
      }, undoLabel)
      if (!committed) throw new Error(`Premiere rejected marker batch ${Math.floor(i / BATCH) + 1} of ${Math.ceil(decisions.length / BATCH)}.`)
    }
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
      let itemName = ''
      if (items.length === 1) {
        const ti = items[0] as VideoClipTrackItem
        isAdj = await ti.isAdjustmentLayer()
        if (!isAdj) {
          try {
            const projItem = await ti.getProjectItem()
            itemName = projItem.name
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
      phase = 'clone sequence'
      ;({ project, sequence } = await this.context())
      if (sequence.guid.toString() !== sequenceId) throw new Error('Active sequence changed. Re-detect before applying.')
      const beforeGuids = new Set((await project.getSequences()).map(s => s.guid.toString()))
      const cloneOk = project.executeTransaction(
        (c) => c.addAction(sequence.createCloneAction()),
        'RoughCut auto-cut clone',
      )
      if (!cloneOk) throw new Error('Premiere rejected the clone transaction.')

      const cloneRef = (await project.getSequences()).find(s => !beforeGuids.has(s.guid.toString()))
      if (!cloneRef) throw new Error('Clone completed but new sequence not found.')
      const cloneId = cloneRef.guid.toString()

      // Rename the clone.
      phase = 'rename clone'
      const baseName = sequence.name.replace(/ - Auto Cut( \d+)?$/, '')
      const cloneName = `${baseName} - Auto Cut`
      const cloneItem = await cloneRef.getProjectItem()
      const renameOk = project.executeTransaction(
        (c) => c.addAction(cloneItem.createSetNameAction(cloneName)),
        'Rename auto-cut clone',
      )
      if (!renameOk) throw new Error('Premiere rejected the rename transaction.')

      // 7. Clear target track on clone (if items exist).
      phase = 'clear target track'
      const clearClone = await this.findSequenceByGuid(project, cloneId)
      if (det.targetTrackIndex < await clearClone.getVideoTrackCount()) {
        const cloneTargetTrack = await clearClone.getVideoTrack(det.targetTrackIndex)
        const existingItems = await cloneTargetTrack.getTrackItems(
          this.ppro.Constants.TrackItemType.CLIP, false,
        )
        if (existingItems.length > 0) {
          const clearEditor = await this.ppro.SequenceEditor.getEditor(clearClone)
          let clearSelection: Awaited<ReturnType<typeof clearClone.getSelection>> | null = null
          this.ppro.TrackItemSelection.createEmptySelection((sel) => { clearSelection = sel })
          if (!clearSelection) {
            // Fallback: use sequence selection.
            clearSelection = await clearClone.getSelection()
          }
          for (const item of existingItems) clearSelection!.addItem(item as VideoClipTrackItem)
          project.lockedAccess(() => {
            const removeOk = project.executeTransaction(
              (c) => c.addAction(clearEditor.createRemoveItemsAction(
                clearSelection!, false, this.ppro.Constants.MediaType.VIDEO, false,
              )),
              'Clear target track',
            )
            if (!removeOk) throw new Error('Premiere rejected the clear-track transaction.')
          })
        }
      }

      // 8. Write cut intervals.
      // Decide insert-vs-overwrite once: does the target track already exist on the clone?
      const cloneTrackCount = await (await this.findSequenceByGuid(project, cloneId)).getVideoTrackCount()
      const useInsertForFirstClip = det.targetTrackIndex >= cloneTrackCount

      try {
        let isFirstClip = true
        for (const iv of intervals) {
          phase = `write cut cam${iv.camera} @${iv.startFrame}`
          // Re-fetch EVERY live handle right before use — UXP invalidates project,
          // sequence, editor, and clip handles across each preceding transaction
          // (BANANAS E4). Re-find by guid so a stale Sequence object never leaks in.
          const srcSeq = await this.findSequenceByGuid(project, sequenceId)
          const srcTrack = await srcSeq.getVideoTrack(
            det.sources.find(s => s.camera === iv.camera)!.vIndex,
          )
          const srcItems = await srcTrack.getTrackItems(this.ppro.Constants.TrackItemType.CLIP, false)
          const projItem = await (srcItems[0] as VideoClipTrackItem).getProjectItem()
          const clip = this.ppro.ClipProjectItem.cast(projItem) as ClipProjectItem

          // Step 1: Set source in/out range.
          const setOk = project.executeTransaction(
            (c) => c.addAction(clip.createSetInOutPointsAction(
              toTick(iv.sourceInFrame),
              toTick(iv.sourceOutFrame),
            )),
            `Set in/out cam${iv.camera}`,
          )
          if (!setOk) throw new Error(`Premiere rejected in/out for camera ${iv.camera}.`)

          // Step 2: Place on target track. Re-fetch the clone's editor AFTER the
          // setInOut transaction above — that transaction stales the prior editor.
          const placeEditor = await this.ppro.SequenceEditor.getEditor(
            await this.findSequenceByGuid(project, cloneId),
          )
          project.lockedAccess(() => {
            if (isFirstClip && useInsertForFirstClip) {
              // Target track doesn't exist yet — use insert so Premiere auto-creates it.
              const insertOk = project.executeTransaction(
                (c) => c.addAction(placeEditor.createInsertProjectItemAction(
                  projItem, toTick(iv.startFrame), det.targetTrackIndex, -1, true,
                )),
                `Insert cam${iv.camera} @${iv.startFrame}`,
              )
              if (!insertOk) throw new Error(`Premiere rejected insert for camera ${iv.camera} at frame ${iv.startFrame}.`)
            } else {
              const writeOk = project.executeTransaction(
                (c) => c.addAction(placeEditor.createOverwriteItemAction(
                  projItem, toTick(iv.startFrame), det.targetTrackIndex, -1,
                )),
                `Overwrite cam${iv.camera} @${iv.startFrame}`,
              )
              if (!writeOk) throw new Error(`Premiere rejected overwrite for camera ${iv.camera} at frame ${iv.startFrame}.`)
            }
            isFirstClip = false
          })
        }
      } finally {
        // 9. Restore source in/out points. Always runs.
        // Re-fetch context and fresh clip handles — every handle from before the
        // cut transactions is stale here (BANANAS E4).
        phase = 'restore source in/out'
        const restoreFailures: string[] = []
        const rp = await this.ppro.Project.getActiveProject()
        if (rp) {
          const rs = await this.findSequenceByGuid(rp, sequenceId)
          for (const src of det.sources) {
            const saved = savedState.get(src.camera)
            if (!saved) continue
            try {
              const freshClip = await this.freshSourceClip(rs, src.vIndex)
              const ok = rp.executeTransaction(
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
      }

      // 10. Activate the clone.
      phase = 'activate clone'
      await project.setActiveSequence(await this.findSequenceByGuid(project, cloneId))

      return cloneName
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/script object is no longer valid/i.test(msg)) {
        throw new Error(`[${phase}] ${msg}`)
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

    // 3. Clone sequence — re-fetch context so DOM refs are fresh after all the read awaits.
    ;({ project, sequence } = await this.context())
    if (sequence.guid.toString() !== sequenceId) throw new Error('Active sequence changed. Re-detect before applying.')
    const beforeGuids = new Set((await project.getSequences()).map(s => s.guid.toString()))
    const cloneOk = project.executeTransaction(
      (c) => c.addAction(sequence.createCloneAction()),
      'RoughCut cold open clone',
    )
    if (!cloneOk) throw new Error('Premiere rejected the clone transaction.')

    const clone = (await project.getSequences()).find(s => !beforeGuids.has(s.guid.toString()))
    if (!clone) throw new Error('Clone completed but new sequence not found.')

    // 4. Rename clone
    const baseName = sequence.name.replace(/ - Cold Open( \d+)?$/, '')
    const cloneName = `${baseName} - Cold Open`
    const cloneItem = await clone.getProjectItem()
    project.executeTransaction(
      (c) => c.addAction(cloneItem.createSetNameAction(cloneName)),
      'Rename cold open clone',
    )

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
        project.lockedAccess(() => {
          project.executeTransaction(
            (c) => c.addAction(editor.createRemoveItemsAction(
              clearSelection!, false, this.ppro.Constants.MediaType.VIDEO, false,
            )),
            'Clear target track',
          )
        })
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
        const setOk = project.executeTransaction(
          (c) => c.addAction(clip.createSetInOutPointsAction(
            toTick(sourceInFrame),
            toTick(sourceOutFrame),
          )),
          `Set hook in/out cam${camNum}`,
        )
        if (!setOk) throw new Error(`Premiere rejected in/out for camera ${camNum}.`)

        project.lockedAccess(() => {
          if (isFirstClip && useInsertForFirstClip) {
            project.executeTransaction(
              (c) => c.addAction(editor.createInsertProjectItemAction(
                projItem, toTick(currentStartFrame), det.targetTrackIndex, -1, true,
              )),
              `Insert hook cam${camNum} @${currentStartFrame}`,
            )
          } else {
            project.executeTransaction(
              (c) => c.addAction(editor.createOverwriteItemAction(
                projItem, toTick(currentStartFrame), det.targetTrackIndex, -1,
              )),
              `Overwrite hook cam${camNum} @${currentStartFrame}`,
            )
          }
          isFirstClip = false
        })

        currentStartFrame += duration
      }
    } finally {
      // 7. Restore source in/out points with re-fetched context and fresh handles.
      const restoreFailures: string[] = []
      const { project: rp, sequence: rs } = await this.context()
      for (const src of det.sources) {
        const saved = savedState.get(src.camera)
        if (!saved) continue
        try {
          const freshClip = await this.freshSourceClip(rs, src.vIndex)
          const ok = rp.executeTransaction(
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
      if (restoreFailures.length > 0) {
        throw new Error(
          `Auto-cut FAILED: could not restore original source in/out points.\n` +
          `Affected cameras:\n${restoreFailures.map(f => `  • ${f}`).join('\n')}\n` +
          `Check these clips in the Source Monitor and reset their in/out points manually.`,
        )
      }
    }

    // 8. Activate the clone
    await project.setActiveSequence(clone)

    return cloneName
  }
}

export function createPremiereAdapter(): PremiereAdapter {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return new MockPremiereAdapter()
  return new UxpPremiereAdapter(runtimeRequire('premierepro') as premierepro)
}

export const premiere = createPremiereAdapter()
export { isPremiereHost }
