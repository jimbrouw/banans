// Names for the sequences RoughCut creates, e.g.
//   "Auto Cut 03 (Balanced · 41 cuts · mics) — Sequence 01"
// The action leads so a timeline tab says what it is before the source name is cut off.
// The run number counts up per source sequence and action, so repeated runs
// are easy to tell apart and match to the run log. Pure, no Premiere calls.

export type RunAction = 'Auto Cut' | 'Clean-up' | 'Clean-up Markers' | 'Review Markers' | 'Cold Open' | 'Social Cut' | 'Clip'

export const BIN_NAME = 'RoughCut'
export const CLIPS_BIN = 'Clips'
export const MEDIA_BIN = 'Imported media'
const SEP = ' — '

// Names from older builds: "X - AI Rough Cut", "X - Auto Cut 2", "X - RoughCut", "X - Cold Open".
const LEGACY_SUFFIX = / - (AI Rough Cut|Auto Cut|RoughCut|Cold Open)( \d+)?$/
const CURRENT_SUFFIX = new RegExp(`${SEP}[A-Za-z -]+ \\d{2,}( \\(.*\\))?$`)
// Names from builds where the source came first: "Sequence 01 — Auto Cut 03 (…)".
const ACTIONS = ['Auto Cut', 'Clean-up Markers', 'Clean-up', 'Review Markers', 'Cold Open', 'Social Cut', 'Clip']
const CURRENT_PREFIX = new RegExp(`^(?:${ACTIONS.join('|')}) \\d{2,}(?: \\(.*?\\))?${SEP}`)

/** The original sequence name, without anything RoughCut appended (so suffixes never stack). */
export function sourceBaseName(name: string): string {
  let base = name.trim()
  for (;;) {
    const next = base.replace(CURRENT_PREFIX, '').replace(CURRENT_SUFFIX, '').replace(LEGACY_SUFFIX, '')
    if (next === base) return base || name
    base = next
  }
}

export function nextSequenceName(source: string, action: RunAction, detail: string, existing: string[]): string {
  const base = sourceBaseName(source)
  const prefix = `${action} `
  const tail = `${SEP}${base}`
  const oldPrefix = `${base}${SEP}${action} `
  const used = existing
    .map((n) => n.startsWith(prefix) && n.endsWith(tail) ? n.slice(prefix.length) : n.startsWith(oldPrefix) ? n.slice(oldPrefix.length) : '')
    .map((n) => parseInt(n, 10))
    .filter(Number.isFinite)
  const run = String(Math.max(0, ...used) + 1).padStart(2, '0')
  return `${prefix}${run}${detail ? ` (${detail})` : ''}${tail}`
}

/** "0:42–1:10" for a time range in seconds. */
export function timeRange(start: number, end: number): string {
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  return `${mmss(start)}–${mmss(end)}`
}
