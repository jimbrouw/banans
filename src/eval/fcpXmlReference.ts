import { XMLParser } from 'fast-xml-parser'
import type { EvalShot } from './types'

type XmlValue = string | number | boolean | XmlRecord | XmlValue[] | undefined
interface XmlRecord { [key: string]: XmlValue }

export interface CameraTrackMapping {
  trackIndex: number
  camera: string
  role: string
}

export interface ReferenceStyleProfile {
  sequenceName: string
  durationSeconds: number
  frameRate: number
  editCount: number
  cameraSwitchCount: number
  sameCameraCutCount: number
  cutsPerMinute: number
  cameraSwitchesPerMinute: number
  averageShotLengthSeconds: number
  medianShotLengthSeconds: number
  minimumShotLengthSeconds: number
  maximumShotLengthSeconds: number
  shotsUnderMinimumCount: number
  cameraUsagePercent: Record<string, number>
  transitionCounts: Record<string, number>
}

export interface ReferenceExtraction {
  profile: ReferenceStyleProfile
  referenceShots: EvalShot[]
  mapping: CameraTrackMapping[]
}

interface TimelineClip {
  id: string
  startFrame: number
  endFrame: number
  enabled: boolean
}

const asRecord = (value: XmlValue): XmlRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlRecord : {}
const asArray = (value: XmlValue) => value === undefined ? [] : Array.isArray(value) ? value : [value]
const numberValue = (value: XmlValue) => typeof value === 'number' ? value : Number(value)
const stringValue = (value: XmlValue) => value === undefined ? '' : String(value)
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const index = (ordered.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)
}

function timelineClips(track: XmlRecord, trackIndex: number): TimelineClip[] {
  return asArray(track.clipitem).flatMap((value, index) => {
    const clip = asRecord(value)
    const startFrame = Math.max(0, numberValue(clip.start))
    const endFrame = numberValue(clip.end)
    if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || endFrame <= startFrame) return []
    return [{
      id: stringValue(clip['@_id']) || `track-${trackIndex}-clip-${index}`,
      startFrame,
      endFrame,
      enabled: stringValue(clip.enabled).toUpperCase() !== 'FALSE',
    }]
  })
}

function transitionCounts(videoTracks: XmlRecord[]) {
  const counts: Record<string, number> = {}
  for (const track of videoTracks) {
    for (const value of asArray(track.transitionitem)) {
      const transition = asRecord(value)
      const effect = asRecord(transition.effect)
      const name = stringValue(effect.name) || stringValue(effect.effectid) || 'Unknown transition'
      counts[name] = (counts[name] ?? 0) + 1
    }
  }
  return counts
}

export function extractFcpXmlReference(xml: string, mapping: CameraTrackMapping[], minimumShotSeconds = 2.5): ReferenceExtraction {
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: true }).parse(xml) as XmlRecord
  const sequence = asRecord(asRecord(parsed.xmeml).sequence)
  if (!stringValue(sequence.name)) throw new Error('The XML does not contain an FCP sequence.')
  const rate = asRecord(sequence.rate)
  const timebase = numberValue(rate.timebase)
  const frameRate = stringValue(rate.ntsc).toUpperCase() === 'TRUE' ? timebase * 1000 / 1001 : timebase
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('The sequence frame rate is invalid.')
  const videoTracks = asArray(asRecord(asRecord(sequence.media).video).track).map(asRecord)
  const configured = mapping.map((item) => ({ ...item, clips: timelineClips(videoTracks[item.trackIndex - 1] ?? {}, item.trackIndex) }))
  if (configured.some((item) => !item.clips.length)) throw new Error('One or more mapped camera tracks contain no clips.')

  const boundaries = new Set<number>()
  for (const track of configured) for (const clip of track.clips) if (clip.enabled) { boundaries.add(clip.startFrame); boundaries.add(clip.endFrame) }
  const frames = [...boundaries].sort((a, b) => a - b)
  const visible: Array<{ startFrame: number; endFrame: number; camera: string; clipId: string }> = []

  for (let index = 0; index < frames.length - 1; index += 1) {
    const startFrame = frames[index]
    const endFrame = frames[index + 1]
    const midpoint = startFrame + (endFrame - startFrame) / 2
    const active = [...configured].sort((a, b) => b.trackIndex - a.trackIndex).flatMap((track) => {
      const clip = track.clips.find((item) => item.enabled && item.startFrame <= midpoint && item.endFrame > midpoint)
      return clip ? [{ track, clip }] : []
    })[0]
    if (!active) continue
    const previous = visible.at(-1)
    if (previous && previous.camera === active.track.camera && previous.clipId === active.clip.id && previous.endFrame === startFrame) previous.endFrame = endFrame
    else visible.push({ startFrame, endFrame, camera: active.track.camera, clipId: active.clip.id })
  }

  const referenceShots = visible.map((shot) => ({ start: shot.startFrame / frameRate, end: shot.endFrame / frameRate, camera: shot.camera }))
  const durations = referenceShots.map((shot) => shot.end - shot.start)
  const durationSeconds = numberValue(sequence.duration) / frameRate
  const editCount = Math.max(0, referenceShots.length - 1)
  const cameraSwitchCount = referenceShots.slice(1).filter((shot, index) => shot.camera !== referenceShots[index].camera).length
  const usageSeconds: Record<string, number> = {}
  for (const shot of referenceShots) usageSeconds[shot.camera] = (usageSeconds[shot.camera] ?? 0) + shot.end - shot.start
  const visibleDuration = Object.values(usageSeconds).reduce((sum, value) => sum + value, 0)
  const cameraUsagePercent = Object.fromEntries(Object.entries(usageSeconds).map(([camera, seconds]) => [camera, visibleDuration ? seconds / visibleDuration * 100 : 0]))

  return {
    mapping,
    referenceShots,
    profile: {
      sequenceName: stringValue(sequence.name), durationSeconds, frameRate, editCount, cameraSwitchCount,
      sameCameraCutCount: editCount - cameraSwitchCount,
      cutsPerMinute: durationSeconds ? editCount / (durationSeconds / 60) : 0,
      cameraSwitchesPerMinute: durationSeconds ? cameraSwitchCount / (durationSeconds / 60) : 0,
      averageShotLengthSeconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
      medianShotLengthSeconds: percentile(durations, .5),
      minimumShotLengthSeconds: durations.length ? Math.min(...durations) : 0,
      maximumShotLengthSeconds: durations.length ? Math.max(...durations) : 0,
      shotsUnderMinimumCount: durations.filter((value) => value < minimumShotSeconds).length,
      cameraUsagePercent, transitionCounts: transitionCounts(videoTracks),
    },
  }
}
