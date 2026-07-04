import type { AnalysisSettings, EditDecision, Platform, SpeakerMapping, TranscriptSegment } from './types'

const summary = (text: string) => text.length > 58 ? `${text.slice(0, 55).trim()}...` : text
const duration = (segment: TranscriptSegment) => Math.max(0, segment.end - segment.start)
const acknowledgement = /^(yeah|yep|yes|right|okay|ok|mm+|mhm|uh-huh|sure|exactly)[.!?, ]*$/i

const fillerPatterns = {
  low: /\b(um+|uh+)\b/i,
  medium: /\b(um+|uh+|you know|i mean|i think,? i think|right,? right)\b/i,
  high: /\b(um+|uh+|you know|i mean|kind of|sort of|basically|literally|like|i think,? i think|right,? right)\b/i,
}

const dependencyPhrases = /\b(as I (said|mentioned)|going back to|like (I|we) (said|discussed)|earlier (I|we)|we (talked|spoke) about|that'?s what I meant)\b/i
const visualDependency = /\b(look at (this|that)|as you can see|on (the|this) (screen|slide|chart|graph|diagram)|this (image|picture|photo))\b/i
const payoffPhrases = /\b(because|that'?s why|the point is|what I (found|learned|realized)|the key (is|takeaway)|the bottom line|in other words)\b/i

function selfContainedScore(text: string, durationSec: number): number {
  let score = 0
  if (durationSec >= 15 && durationSec <= 60) score += 0.3
  else if (durationSec >= 10) score += 0.1
  if (payoffPhrases.test(text)) score += 0.2
  if (!dependencyPhrases.test(text)) score += 0.2
  if (!visualDependency.test(text)) score += 0.15
  const firstSentence = text.split(/[.!?]/)[0]
  if (hookPatterns.some((p) => p.test(firstSentence))) score += 0.15
  return Math.min(1, score)
}

function derivePlatforms(durationSec: number, type: string): Platform[] {
  if (type === 'audiogram') return ['audiogram']
  if (durationSec <= 15) return ['stories']
  if (durationSec <= 45) return ['shorts', 'reels', 'tiktok', 'stories']
  if (durationSec <= 60) return ['shorts', 'reels', 'tiktok']
  return []
}

const hookPatterns = [
  /^(why|how|what|who|when|where|is|are|do|does|did|can|could|would|should|have|has|had)\b/i,
  /\b(secret|mistake|lessons|reason|fact|hack|tip|strategy|trick|proven|shocking|crazy|unexpected)\b/i,
  /^(you won't believe|i learned|most people|the truth about|how to)\b/i
]

function mergeTrimDecisions(decisions: Omit<EditDecision, 'selected'>[]) {
  const trims = decisions.filter((item) => item.type === 'suggested_trim').sort((a, b) => a.start - b.start)
  const others = decisions.filter((item) => item.type !== 'suggested_trim')
  const merged: typeof trims = []
  for (const trim of trims) {
    const previous = merged.at(-1)
    if (previous && trim.start <= (previous.end ?? previous.start) + .1) {
      previous.end = Math.max(previous.end ?? previous.start, trim.end ?? trim.start)
      if (!previous.detail.includes(trim.detail)) previous.detail = `${previous.detail}; ${trim.detail}`
      previous.confidence = Math.max(previous.confidence, trim.confidence)
    } else merged.push({ ...trim })
  }
  return [...others, ...merged].sort((a, b) => a.start - b.start)
}

function cameraPlan(segments: TranscriptSegment[], settings: AnalysisSettings, mappings: SpeakerMapping[]): Omit<EditDecision, 'selected'>[] {
  if (!settings.cameraPlan) return []
  const cameraFor = (speaker: string) => mappings.find((mapping) => mapping.speaker === speaker)?.camera ?? 'Wide'
  const decisions: Omit<EditDecision, 'selected'>[] = []
  let lastCamera = ''
  let lastSwitch = Number.NEGATIVE_INFINITY

  segments.forEach((segment, index) => {
    const next = segments[index + 1]
    const isShortInterjection = duration(segment) < settings.minimumShotSeconds || acknowledgement.test(segment.text.trim())
    const overlapsNextSpeaker = next && next.speaker !== segment.speaker && next.start < segment.end - .25
    const target = overlapsNextSpeaker ? 'Wide' : cameraFor(segment.speaker)
    if (isShortInterjection || target === lastCamera || segment.start - lastSwitch < settings.minimumShotSeconds) return
    decisions.push({
      id: `camera-${segment.id}`,
      start: segment.start,
      end: segment.end,
      type: 'camera_switch',
      label: `Camera suggestion: ${target}`,
      detail: overlapsNextSpeaker ? 'Overlapping speakers; use fallback wide shot' : `${segment.speaker} begins a sustained turn`,
      confidence: overlapsNextSpeaker ? .82 : Math.min(.94, Math.max(.76, segment.confidence)),
    })
    lastCamera = target
    lastSwitch = segment.start
  })
  return decisions
}

export async function analyseTranscript(transcript: TranscriptSegment[], settings: AnalysisSettings, mappings: SpeakerMapping[] = []) {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 450))
  const ordered = [...transcript].sort((a, b) => a.start - b.start)
  const candidates: Omit<EditDecision, 'selected'>[] = []

  ordered.forEach((segment, index) => {
    const segmentDuration = duration(segment)
    if (settings.socialClips && segmentDuration >= settings.minimumClipSeconds && segment.text.length >= 60) {
      const sc = selfContainedScore(segment.text, segmentDuration)
      candidates.push({ id: `social-${segment.id}`, start: segment.start, end: segment.end, type: 'social_clip', label: 'Strong clip', detail: summary(segment.text), confidence: Math.min(.96, Math.max(.72, segment.confidence)), selfContainedScore: sc, platforms: derivePlatforms(segmentDuration, 'social_clip') })
    }
    if (settings.chapters && (index === 0 || (index > 0 && index % Math.max(2, Math.floor(ordered.length / 3)) === 0))) {
      candidates.push({ id: `chapter-${segment.id}`, start: segment.start, type: 'chapter', label: 'Chapter', detail: summary(segment.text), confidence: Math.min(.94, segment.confidence) })
    }
    if (settings.suggestedTrims && fillerPatterns[settings.fillerAggressiveness].test(segment.text)) {
      candidates.push({ id: `trim-${segment.id}`, start: segment.start, end: segment.end, type: 'suggested_trim', label: 'Filler review', detail: summary(segment.text), confidence: settings.fillerAggressiveness === 'high' ? .72 : .84 })
    }
    const next = ordered[index + 1]
    const gap = next ? next.start - segment.end : 0
    if (settings.pauseMarkers && gap >= settings.minimumPauseSeconds) {
      const padding = Math.min(.2, gap / 4)
      candidates.push({ id: `pause-${segment.id}`, start: segment.end + padding, end: next.start - padding, type: 'suggested_trim', label: 'Pause review', detail: `${gap.toFixed(1)}s transcript gap`, confidence: gap >= settings.minimumPauseSeconds * 2 ? .92 : .82 })
    }
    if (segment.confidence < .75) {
      candidates.push({ id: `warning-${segment.id}`, start: segment.start, end: segment.end, type: 'warning', label: 'Transcript warning', detail: summary(segment.text), confidence: segment.confidence })
    }
    if (segmentDuration >= 20 && /\b(is|means|because|choice|mistake|lesson)\b/i.test(segment.text)) {
      candidates.push({ id: `quote-${segment.id}`, start: segment.start, end: segment.end, type: 'strong_quote', label: 'Strong quote', detail: summary(segment.text), confidence: Math.min(.93, segment.confidence) })
    }
    const isHook = hookPatterns.some((p) => p.test(segment.text.trim()))
    if (segmentDuration >= 8 && segmentDuration <= 35 && isHook) {
      candidates.push({ id: `hook-${segment.id}`, start: segment.start, end: segment.end, type: 'social_hook', label: `Inquisitive hook (${segment.speaker})`, detail: summary(segment.text), confidence: Math.min(.96, Math.max(.75, segment.confidence)), selfContainedScore: selfContainedScore(segment.text, segmentDuration), platforms: derivePlatforms(segmentDuration, 'social_hook') })
    }
    if (settings.socialClips && segmentDuration >= 15 && segmentDuration <= 45 && segment.confidence >= 0.75 && !visualDependency.test(segment.text)) {
      const isInsightful = /\b(is|means|because|mistake|lesson|truth|key|difference|problem|solution|important|reality)\b/i.test(segment.text)
      if (isInsightful) {
        candidates.push({ id: `audiogram-${segment.id}`, start: segment.start, end: segment.end, type: 'audiogram', label: 'Audiogram candidate', detail: summary(segment.text), confidence: Math.min(.92, segment.confidence), selfContainedScore: selfContainedScore(segment.text, segmentDuration), platforms: ['audiogram'] })
      }
    }
  })

  candidates.push(...cameraPlan(ordered, settings, mappings))
  return mergeTrimDecisions(candidates)
    .filter((decision) => decision.confidence >= settings.confidenceThreshold)
    .map((decision) => ({ ...decision, selected: decision.type !== 'warning' }))
}

export { cameraPlan, mergeTrimDecisions }
