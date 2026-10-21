// Pure logic for the Review screen: engine words + silences (source-media time)
// → sequence-time cuts the editor can toggle. No Premiere or network calls.

import type { EngineWord, SilenceRange } from './engineClient'
import type { EditDecision } from './types'

/** A clip on the primary audio track. start/end are sequence seconds; inPoint is source seconds. */
export interface SourceClip { path: string; start: number; end: number; inPoint: number }

export interface ReviewWord { text: string; start: number; end: number; filler: boolean; segment: string }
export type AiReason = 'retake' | 'false_start' | 'repeat' | 'off_topic' | 'instruction'
export type CutReason = 'silence' | 'filler' | AiReason
/** A removal suggested by the AI pass, already in sequence time. */
export interface AiRemoval { start: number; end: number; reason: AiReason; note: string }
/** A sentence-sized piece of transcript: what the AI pass reads and cuts by. */
export interface SpeechUnit { id: number; start: number; end: number; text: string }
export interface ReviewCut { id: string; start: number; end: number; reasons: CutReason[]; label: string; active: boolean }
export interface ReviewSettings { minSilence: number; padding: number; cutFillers: boolean }

export const defaultReviewSettings: ReviewSettings = { minSilence: 0.6, padding: 0.12, cutFillers: true }

const MIN_CUT = 0.08 // anything shorter isn't worth a cut
const MERGE_GAP = 0.05 // cuts this close become one

const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * Map source-time ranges into sequence time for one clip. Items whose midpoint
 * falls outside the clip's used source window are dropped; the rest are clamped.
 */
export function mapToSequence<T extends { start: number; end: number }>(items: T[], clip: SourceClip): T[] {
  const srcOut = clip.inPoint + (clip.end - clip.start)
  const toSeq = (t: number) => round(clip.start + (Math.min(Math.max(t, clip.inPoint), srcOut) - clip.inPoint))
  return items
    .filter((it) => { const mid = (it.start + it.end) / 2; return mid >= clip.inPoint && mid <= srcOut })
    .map((it) => ({ ...it, start: toSeq(it.start), end: toSeq(it.end) }))
}

export function wordsForClip(words: EngineWord[], clip: SourceClip, clipIndex: number): ReviewWord[] {
  return mapToSequence(words, clip).map((w) => ({ text: w.text, start: w.start, end: w.end, filler: w.filler, segment: `${clipIndex}:${w.segment}` }))
}

/** Remove the parts of `range` covered by any of `blockers`. */
function subtract(range: SilenceRange, blockers: { start: number; end: number }[]): SilenceRange[] {
  let pieces = [range]
  for (const b of blockers) {
    pieces = pieces.flatMap((p) => {
      if (b.end <= p.start || b.start >= p.end) return [p]
      return [{ start: p.start, end: b.start }, { start: b.end, end: p.end }].filter((x) => x.end > x.start)
    })
  }
  return pieces
}

export const aiReasonLabel: Record<AiReason, string> = {
  retake: 'Retake', false_start: 'False start', repeat: 'Repeat', off_topic: 'Off-topic', instruction: 'Your edit',
}
const isAi = (r: CutReason): r is AiReason => r in aiReasonLabel

export function buildCuts(words: ReviewWord[], silences: SilenceRange[], settings: ReviewSettings, ai: AiRemoval[] = []): ReviewCut[] {
  // Never cut through a real word, even if the audio there reads as quiet.
  const spoken = words.filter((w) => !w.filler)
  const raw: { start: number; end: number; reason: CutReason; text?: string; note?: string }[] = []

  for (const s of silences) {
    if (s.end - s.start < settings.minSilence) continue
    const padded = { start: s.start + settings.padding, end: s.end - settings.padding }
    if (padded.end <= padded.start) continue
    for (const piece of subtract(padded, spoken)) raw.push({ ...piece, reason: 'silence' })
  }
  if (settings.cutFillers) {
    for (const w of words) if (w.filler) raw.push({ start: w.start, end: w.end, reason: 'filler', text: w.text })
  }
  for (const r of ai) raw.push({ start: r.start, end: r.end, reason: r.reason, note: r.note })

  raw.sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number; reasons: Set<CutReason>; fillers: string[]; notes: string[] }[] = []
  for (const r of raw) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end <= MERGE_GAP) {
      last.end = Math.max(last.end, r.end)
      last.reasons.add(r.reason)
      if (r.text) last.fillers.push(r.text)
      if (r.note) last.notes.push(r.note)
    } else {
      merged.push({ start: r.start, end: r.end, reasons: new Set([r.reason]), fillers: r.text ? [r.text] : [], notes: r.note ? [r.note] : [] })
    }
  }

  return merged
    .filter((m) => m.end - m.start >= MIN_CUT)
    .map((m, i) => {
      const secs = (m.end - m.start).toFixed(1)
      const fillers = m.fillers.map((f) => `"${f.replace(/[^\w']/g, '')}"`).join(' ')
      const aiReason = [...m.reasons].find(isAi)
      const label = aiReason ? `${aiReasonLabel[aiReason]} · ${secs}s${m.notes[0] ? ` · ${m.notes[0]}` : ''}`
        : m.reasons.has('filler') && m.reasons.has('silence') ? `Pause + filler ${fillers} · ${secs}s`
        : m.reasons.has('filler') ? `Filler ${fillers}` : `Pause ${secs}s`
      return { id: `cut-${i}`, start: round(m.start), end: round(m.end), reasons: [...m.reasons], label, active: true }
    })
}

/**
 * Split words into sentence-sized units for the AI pass: a new unit at each
 * whisper segment, after sentence-ending punctuation, or after a long gap.
 * Small units let the AI cut a false start without taking the whole segment.
 */
export function speechUnits(words: ReviewWord[], gap = 0.8): SpeechUnit[] {
  const units: SpeechUnit[] = []
  let current: ReviewWord[] = []
  const flush = () => {
    if (!current.length) return
    units.push({ id: units.length, start: current[0].start, end: current[current.length - 1].end, text: current.map((w) => w.text).join(' ') })
    current = []
  }
  const sorted = [...words].sort((a, b) => a.start - b.start)
  sorted.forEach((w, i) => {
    const prev = sorted[i - 1]
    if (prev && (prev.segment !== w.segment || w.start - prev.end > gap)) flush()
    current.push(w)
    if (/[.?!]["')\]]*$/.test(w.text)) flush()
  })
  flush()
  return units
}

/** Group words into transcript lines (one per whisper segment) for display. */
export function groupLines(words: ReviewWord[]): { id: string; start: number; end: number; words: ReviewWord[] }[] {
  const lines: { id: string; start: number; end: number; words: ReviewWord[] }[] = []
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const last = lines[lines.length - 1]
    if (last && last.id === w.segment) { last.words.push(w); last.end = w.end }
    else lines.push({ id: w.segment, start: w.start, end: w.end, words: [w] })
  }
  return lines
}

export function summarise(cuts: ReviewCut[]) {
  const active = cuts.filter((c) => c.active)
  return { count: active.length, seconds: round(active.reduce((sum, c) => sum + (c.end - c.start), 0)) }
}

/** Active cuts as trim markers, so the existing "marked review cut" path can write them. */
export function cutsToDecisions(cuts: ReviewCut[]): EditDecision[] {
  return cuts.filter((c) => c.active).map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    type: 'suggested_trim',
    label: c.label,
    detail: `RoughCut review: ${c.reasons.join(' + ')}`,
    confidence: 1,
    selected: true,
  }))
}
