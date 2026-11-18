// Scores a selects pass against clips an editor actually published.
// Not my judgement and not the model's: did it find the editor's moments,
// how high did it rank them, and how close are its edges and opening line?

import type { ReferenceClip, Span } from './clipReference'

export interface PredictedClip { title: string; pieces: Span[] }
export interface ReferenceMatch {
  reference: string
  found: boolean
  rank: number | null          // 1-based position of the matching pick
  coverage: number             // share of the editor's clip the pick covers
  iou: number                  // overlap ÷ union of the two clips' episode time
  startError: number | null    // seconds between the two clips' first moments in the episode
  endError: number | null
  sameOpening: boolean         // does the pick open on the editor's opening moment (±3 s)?
}
export interface SelectsScore { found: number; total: number; meanIoU: number; matches: ReferenceMatch[] }

const length = (spans: Span[]) => spans.reduce((s, p) => s + Math.max(0, p.end - p.start), 0)

/** Merge spans into a sorted, non-overlapping set. */
export function union(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

function overlap(a: Span[], b: Span[]): number {
  let total = 0
  for (const x of union(a)) for (const y of union(b)) total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start))
  return total
}

const extent = (spans: Span[]) => ({ start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) })
const round = (n: number) => Math.round(n * 100) / 100

/** A pick "finds" an editor's clip when it covers at least half of it. */
export function scoreSelects(picks: PredictedClip[], references: ReferenceClip[], foundAt = 0.5): SelectsScore {
  const matches = references.map((ref): ReferenceMatch => {
    const refLen = length(union(ref.pieces))
    let best: { i: number; coverage: number; iou: number } | null = null
    picks.forEach((p, i) => {
      const o = overlap(p.pieces, ref.pieces)
      const coverage = refLen ? o / refLen : 0
      const iou = o / (length(union([...p.pieces, ...ref.pieces])) || 1)
      if (!best || coverage > best.coverage) best = { i, coverage, iou }
    })
    const b = best as { i: number; coverage: number; iou: number } | null
    const found = !!b && b.coverage >= foundAt
    const pick = b ? picks[b.i] : null
    const pe = pick ? extent(pick.pieces) : null
    const re = extent(ref.pieces)
    return {
      reference: ref.name,
      found,
      rank: found && b ? b.i + 1 : null,
      coverage: round(b?.coverage ?? 0),
      iou: round(b?.iou ?? 0),
      startError: found && pe ? round(Math.abs(pe.start - re.start)) : null,
      endError: found && pe ? round(Math.abs(pe.end - re.end)) : null,
      sameOpening: found && !!pick && Math.abs(pick.pieces[0].start - ref.pieces[0].start) <= 3,
    }
  })
  const found = matches.filter((m) => m.found)
  return { found: found.length, total: references.length, meanIoU: round(matches.reduce((s, m) => s + m.iou, 0) / (matches.length || 1)), matches }
}
