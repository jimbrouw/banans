import type { CutPoint } from './cutEngine'
import type { TranscriptSegment, SpeakerMapping } from './types'

export interface AutopilotProfile {
  name: string
  description: string
  minShotSeconds: number
  switchAggressiveness: 'low' | 'medium' | 'high'
}

export interface AutopilotEvalCheck {
  label: string
  pass: boolean
  detail: string
}

export interface AutopilotOption {
  id: string
  profile: AutopilotProfile
  cuts: CutPoint[]
  score: number
  checks: AutopilotEvalCheck[]
}

const acknowledgement = /^(yeah|yep|yes|right|okay|ok|mm+|mhm|uh-huh|sure|exactly)[.!?, ]*$/i

export function resolveCameraNum(
  cameraName: string,
  sources: { camera: number; name: string }[]
): number {
  if (!sources || sources.length === 0) return 1

  // 1. Try exact match on source name
  let found = sources.find(s => s.name === cameraName)
  if (found) return found.camera

  // 2. Try substring match (case insensitive)
  found = sources.find(s => s.name.toLowerCase().includes(cameraName.toLowerCase()))
  if (found) return found.camera

  // 3. Try parsing numeric suffix (e.g. "Camera 1" -> 1, "Camera 2" -> 2)
  const match = cameraName.match(/(\d+)/)
  if (match) {
    const num = parseInt(match[1], 10)
    if (num >= 1 && num <= sources.length) {
      return num
    }
  }

  // 4. Try matching "wide" to a source containing "wide"
  if (cameraName.toLowerCase().includes('wide')) {
    const wideSrc = sources.find(s => s.name.toLowerCase().includes('wide'))
    if (wideSrc) return wideSrc.camera
    // Fallback to the last camera
    return sources.length
  }

  // 5. Fallback to camera 1
  return 1
}

export function generateCutMapForProfile(
  segments: TranscriptSegment[],
  mappings: SpeakerMapping[],
  sources: { camera: number; name: string }[],
  profile: AutopilotProfile,
  totalFrames: number,
  frameRate: number
): CutPoint[] {
  if (segments.length === 0) {
    return [{ frame: 0, camera: 1 }]
  }

  const cameraFor = (speaker: string) => {
    const map = mappings.find(m => m.speaker === speaker)
    return map ? resolveCameraNum(map.camera, sources) : resolveCameraNum('Wide', sources)
  }

  const wideCamera = resolveCameraNum('Wide', sources)
  const ordered = [...segments].sort((a, b) => a.start - b.start)
  const cuts: CutPoint[] = []

  let lastCamera = -1
  let lastSwitchTime = -100

  // Standard frame helpers
  const toFrame = (sec: number) => Math.min(totalFrames - 1, Math.max(0, Math.round(sec * frameRate)))

  ordered.forEach((segment, index) => {
    const next = ordered[index + 1]
    const duration = Math.max(0, segment.end - segment.start)

    // Acknowledgment filter
    const isShortInterjection = duration < profile.minShotSeconds || acknowledgement.test(segment.text.trim())
    const overlapsNextSpeaker = next && next.speaker !== segment.speaker && next.start < segment.end - 0.25

    const target = overlapsNextSpeaker ? wideCamera : cameraFor(segment.speaker)

    if (isShortInterjection && profile.switchAggressiveness !== 'high') {
      return
    }

    if (target === lastCamera) {
      return
    }

    // Enforce minimum shot duration (except for the very first switch)
    if (lastCamera !== -1 && segment.start - lastSwitchTime < profile.minShotSeconds) {
      return
    }

    cuts.push({
      frame: toFrame(segment.start),
      camera: target
    })

    lastCamera = target
    lastSwitchTime = segment.start
  })

  // Ensure first cut starts at frame 0
  if (cuts.length === 0) {
    cuts.push({ frame: 0, camera: 1 })
  } else if (cuts[0].frame > 0) {
    cuts.unshift({ frame: 0, camera: cuts[0].camera })
  }

  // Deduplicate cuts at duplicate frames (keep the last one)
  const cleanCuts: CutPoint[] = []
  cuts.forEach(cut => {
    const existing = cleanCuts.find(c => c.frame === cut.frame)
    if (existing) {
      existing.camera = cut.camera
    } else {
      cleanCuts.push(cut)
    }
  })

  return cleanCuts.sort((a, b) => a.frame - b.frame)
}

export function evaluateCutMap(
  cuts: CutPoint[],
  segments: TranscriptSegment[],
  mappings: SpeakerMapping[],
  sources: { camera: number; name: string }[],
  profile: AutopilotProfile,
  totalFrames: number,
  frameRate: number
): { score: number; checks: AutopilotEvalCheck[] } {
  void mappings
  const durationSeconds = totalFrames / frameRate
  const cutsPerMin = cuts.length ? (cuts.length - 1) / (durationSeconds / 60 || 1) : 0

  const toSec = (frame: number) => frame / frameRate

  // Rule 1: Min Shot Duration
  let minShotPass = true
  let shortestShot = Number.MAX_VALUE
  for (let i = 0; i < cuts.length; i++) {
    const start = toSec(cuts[i].frame)
    const end = i === cuts.length - 1 ? durationSeconds : toSec(cuts[i + 1].frame)
    const len = end - start
    if (len < profile.minShotSeconds) {
      minShotPass = false
    }
    if (len < shortestShot) shortestShot = len
  }

  const checkMinShot: AutopilotEvalCheck = {
    label: 'Shot Duration Check',
    pass: minShotPass,
    detail: minShotPass
      ? `All shots meet the minimum duration of ${profile.minShotSeconds}s.`
      : `Some shots are shorter than ${profile.minShotSeconds}s (shortest: ${shortestShot.toFixed(1)}s).`
  }

  // Rule 2: Cut Frequency
  const maxCutsPerMin = profile.switchAggressiveness === 'high' ? 12 : profile.switchAggressiveness === 'medium' ? 8 : 5
  const freqPass = cutsPerMin <= maxCutsPerMin
  const checkFreq: AutopilotEvalCheck = {
    label: 'Switch Frequency Check',
    pass: freqPass,
    detail: `Pace is ${cutsPerMin.toFixed(1)} cuts/min (limit for profile is ${maxCutsPerMin}/min).`
  }

  // Rule 3: Overlap Wide Check
  const wideCamera = resolveCameraNum('Wide', sources)
  let overlapCorrect = 0
  let overlapTotal = 0
  const ordered = [...segments].sort((a, b) => a.start - b.start)

  ordered.forEach((segment, index) => {
    const next = ordered[index + 1]
    if (next && next.speaker !== segment.speaker && next.start < segment.end - 0.25) {
      overlapTotal++
      // Find what camera is active during this overlap
      const midPoint = (segment.end + next.start) / 2
      const activeCut = [...cuts].reverse().find(c => toSec(c.frame) <= midPoint)
      if (activeCut && activeCut.camera === wideCamera) {
        overlapCorrect++
      }
    }
  })

  const overlapPass = overlapTotal === 0 || (overlapCorrect / overlapTotal) >= 0.75
  const checkOverlap: AutopilotEvalCheck = {
    label: 'Overlap Wide Check',
    pass: overlapPass,
    detail: overlapTotal === 0
      ? 'No conversational overlaps detected.'
      : `${overlapCorrect}/${overlapTotal} overlaps correctly cut to Wide camera.`
  }

  // Rule 4: Switch Stability (no double switches within 1.0s)
  let stablePass = true
  for (let i = 0; i < cuts.length - 1; i++) {
    if (toSec(cuts[i + 1].frame) - toSec(cuts[i].frame) < 1.0) {
      stablePass = false
      break
    }
  }

  const checkStability: AutopilotEvalCheck = {
    label: 'Switch Stability Check',
    pass: stablePass,
    detail: stablePass
      ? 'No rapid camera switches within 1.0s.'
      : 'Contains rapid double-switches within 1.0s.'
  }

  const checks = [checkMinShot, checkFreq, checkOverlap, checkStability]
  const passedCount = checks.filter(c => c.pass).length
  const score = Math.round((passedCount / checks.length) * 100)

  return { score, checks }
}

export const profiles: AutopilotProfile[] = [
  {
    name: 'Balanced (Recommended)',
    description: 'Switches on sustained speaker turns with wide camera on overlaps. Minimum shot duration of 2.5s.',
    minShotSeconds: 2.5,
    switchAggressiveness: 'medium'
  },
  {
    name: 'Dynamic Cut',
    description: 'Aggressive camera switching on turn starts and short comments. Minimum shot duration of 1.5s.',
    minShotSeconds: 1.5,
    switchAggressiveness: 'high'
  },
  {
    name: 'Conservative Dialogue',
    description: 'Slower, conversational editing style. Restricts switches to long segments. Minimum shot duration of 4.0s.',
    minShotSeconds: 4.0,
    switchAggressiveness: 'low'
  }
]

export function getAutopilotOptions(
  segments: TranscriptSegment[],
  mappings: SpeakerMapping[],
  sources: { camera: number; name: string }[],
  totalFrames: number,
  frameRate: number
): AutopilotOption[] {
  const options: AutopilotOption[] = profiles.map((profile, index) => {
    const cuts = generateCutMapForProfile(segments, mappings, sources, profile, totalFrames, frameRate)
    const { score, checks } = evaluateCutMap(cuts, segments, mappings, sources, profile, totalFrames, frameRate)
    return {
      id: `autopilot-option-${index}`,
      profile,
      cuts,
      score,
      checks
    }
  })

  // Sort: highest score first
  return options.sort((a, b) => b.score - a.score)
}
