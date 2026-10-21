// Names for the sequences RoughCut creates, e.g.
//   "Sequence 01 — Auto Cut 03 (Balanced · 41 cuts · mics)"
// The run number counts up per source sequence and action, so repeated runs
// are easy to tell apart and match to the run log. Pure, no Premiere calls.

export type RunAction = 'Auto Cut' | 'Clean-up' | 'Clean-up Markers' | 'Review Markers' | 'Cold Open' | 'Social Cut' | 'Clip'

export const BIN_NAME = 'RoughCut'
export const CLIPS_BIN = 'Clips'
const SEP = ' — '

// Names from older builds: "X - AI Rough Cut", "X - Auto Cut 2", "X - RoughCut", "X - Cold Open".
const LEGACY_SUFFIX = / - (AI Rough Cut|Auto Cut|RoughCut|Cold Open)( \d+)?$/
const CURRENT_SUFFIX = new RegExp(`${SEP}[A-Za-z -]+ \\d{2,}( \\(.*\\))?$`)

/** The original sequence name, without anything RoughCut appended (so suffixes never stack). */
export function sourceBaseName(name: string): string {
  let base = name.trim()
  for (;;) {
    const next = base.replace(CURRENT_SUFFIX, '').replace(LEGACY_SUFFIX, '')
    if (next === base) return base || name
    base = next
  }
}

export function nextSequenceName(source: string, action: RunAction, detail: string, existing: string[]): string {
  const prefix = `${sourceBaseName(source)}${SEP}${action} `
  const used = existing
    .filter((n) => n.startsWith(prefix))
    .map((n) => parseInt(n.slice(prefix.length), 10))
    .filter(Number.isFinite)
  const run = String(Math.max(0, ...used) + 1).padStart(2, '0')
  return `${prefix}${run}${detail ? ` (${detail})` : ''}`
}

/** "0:42–1:10" for a time range in seconds. */
export function timeRange(start: number, end: number): string {
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  return `${mmss(start)}–${mmss(end)}`
}
