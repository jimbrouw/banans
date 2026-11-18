// Podcast Mode fallback: who's talking, from each mic's loudness.
// Used when Premiere's transcript has no speaker labels. Pure, no Premiere calls.
//
// Each mic's dB envelope (from the engine, in source time) is placed on the
// sequence timeline, then each 1/rate-second frame marks a mic active when it
// is well above its own noise floor AND close to the loudest mic. The second
// rule rejects bleed (the guest faintly in the host's mic) but keeps real
// crosstalk, which the autopilot turns into a wide shot.

import type { SourceClip } from './reviewModel'
import type { TranscriptSegment } from './types'

export const FLOOR_DB = -100

export interface Envelope { rate: number; db: number[] }
export interface SpeakerOptions { speechAboveFloorDb: number; bleedDb: number; minTurn: number; maxGap: number }
export const defaultSpeakerOptions: SpeakerOptions = { speechAboveFloorDb: 12, bleedDb: 6, minTurn: 0.4, maxGap: 0.6 }

/** One mic's envelope on the sequence timeline: every clip on its track, placed where it sits. */
export function placeEnvelope(clips: SourceClip[], levelsByPath: Map<string, Envelope>, duration: number, rate: number): number[] {
  const out = new Array<number>(Math.ceil(duration * rate)).fill(FLOOR_DB)
  for (const clip of clips) {
    const env = levelsByPath.get(clip.path)
    if (!env) continue
    const from = Math.max(0, Math.round(clip.start * rate))
    const to = Math.min(out.length, Math.round(clip.end * rate))
    for (let i = from; i < to; i++) {
      const src = Math.round((clip.inPoint + (i / rate - clip.start)) * env.rate)
      if (src >= 0 && src < env.db.length) out[i] = env.db[src]
    }
  }
  return out
}

/** Noise floor: a low percentile of the frames that actually have signal. */
function noiseFloor(db: number[]): number {
  const live = db.filter((v) => v > FLOOR_DB + 1).sort((a, b) => a - b)
  return live.length ? live[Math.floor(live.length * 0.05)] : FLOOR_DB
}

/** Fill short gaps, then drop runs shorter than minTurn. Returns [start, end) frame runs. */
function smooth(active: boolean[], rate: number, opts: SpeakerOptions): [number, number][] {
  const runs: [number, number][] = []
  active.forEach((on, i) => {
    if (!on) return
    const last = runs[runs.length - 1]
    if (last && i - last[1] <= opts.maxGap * rate) last[1] = i + 1
    else runs.push([i, i + 1])
  })
  return runs.filter(([a, b]) => b - a >= opts.minTurn * rate)
}

/** Per mic, the time ranges (seconds) it is the active speaker. */
export function detectSpeakers(envelopes: number[][], rate: number, opts: SpeakerOptions = defaultSpeakerOptions): { start: number; end: number }[][] {
  const floors = envelopes.map(noiseFloor)
  const frames = Math.max(0, ...envelopes.map((e) => e.length))
  const active = envelopes.map(() => new Array<boolean>(frames).fill(false))
  for (let i = 0; i < frames; i++) {
    const rel = envelopes.map((e, m) => (e[i] ?? FLOOR_DB) - floors[m])
    const loudest = Math.max(...rel)
    rel.forEach((r, m) => { active[m][i] = r >= opts.speechAboveFloorDb && r >= loudest - opts.bleedDb })
  }
  return active.map((a) => smooth(a, rate, opts).map(([s, e]) => ({ start: s / rate, end: e / rate })))
}

/** Speaker turns as transcript-style segments, so the existing autopilot can cut on them. */
export function turnsToSegments(labels: string[], turns: { start: number; end: number }[][]): TranscriptSegment[] {
  return turns
    .flatMap((list, m) => list.map((t, i) => ({ id: `mic-${m}-${i}`, speaker: labels[m], start: t.start, end: t.end, text: '', confidence: 1 })))
    .sort((a, b) => a.start - b.start)
}

/** Share of the total talk time per mic, for the UI summary. */
export function talkShare(turns: { start: number; end: number }[][]): number[] {
  const totals = turns.map((list) => list.reduce((sum, t) => sum + (t.end - t.start), 0))
  const all = totals.reduce((a, b) => a + b, 0) || 1
  return totals.map((t) => t / all)
}

/** True when Premiere's transcript labels at least two different speakers. */
export function hasSpeakerLabels(segments: TranscriptSegment[]): boolean {
  return new Set(segments.map((s) => s.speaker).filter((s) => s && s !== 'Unknown')).size >= 2
}
