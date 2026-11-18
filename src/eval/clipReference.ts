// Reference clips for the selects eval: which stretches of the episode an
// editor's published clip actually uses, and in what order.
//
// Reads a clip sequence's FCP XML (Premiere: File → Export → Final Cut Pro XML).
// A clip piece is in "episode time" when its clipitem is the nested episode
// sequence, or the episode's audio mixdown: either way its in/out points are
// positions on the episode timeline.

import { XMLParser } from 'fast-xml-parser'

export interface Span { start: number; end: number }
export interface ReferenceClip {
  name: string
  durationSeconds: number
  vertical: boolean
  /** Episode-time pieces in the order they play in the clip. */
  pieces: Span[]
}

type X = Record<string, unknown>
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const rec = (v: unknown): X => (v && typeof v === 'object' ? (v as X) : {})
const fps = (rate: unknown) => {
  const r = rec(rate)
  const tb = Number(r.timebase)
  return String(r.ntsc).toUpperCase() === 'TRUE' ? tb * 1000 / 1001 : tb
}

/**
 * @param isEpisode decides whether a clipitem (by name) is the episode: the nested
 *   episode sequence or its mixdown audio file.
 */
export function readReferenceClip(xml: string, isEpisode: (clipName: string) => boolean, gapTolerance = 0.1): ReferenceClip {
  const doc = new XMLParser({ ignoreAttributes: false, isArray: (n) => ['track', 'clipitem'].includes(n) }).parse(xml) as X
  const seq = rec(rec(doc.xmeml).sequence)
  if (!seq.name) throw new Error('No sequence in this XML.')
  const seqFps = fps(seq.rate)
  const media = rec(seq.media)
  const format = rec(rec(rec(media.video).format).samplecharacteristics)
  // Audio defines the clip (what is said); fall back to video if there is no episode audio.
  const tracks = [...asArray(rec(media.audio).track as X[]), ...asArray(rec(media.video).track as X[])]
  let raw: { tl: number; span: Span }[] = []
  for (const track of tracks) {
    const items = asArray(rec(track).clipitem as X[]).filter((c) => isEpisode(String(c.name ?? '')))
    if (!items.length) continue
    raw = items.map((c) => {
      const f = fps(c.rate) || seqFps
      return { tl: Number(c.start) / seqFps, span: { start: Number(c.in) / f, end: Number(c.out) / f } }
    })
    break
  }
  if (!raw.length) throw new Error(`No clip in "${seq.name}" comes from the episode.`)
  raw.sort((a, b) => a.tl - b.tl)

  // Pieces that continue straight on from the previous one are one stretch.
  const pieces: Span[] = []
  for (const { span } of raw) {
    const last = pieces[pieces.length - 1]
    if (last && Math.abs(span.start - last.end) <= gapTolerance) last.end = span.end
    else pieces.push({ ...span })
  }
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    name: String(seq.name),
    durationSeconds: round(Number(seq.duration) / seqFps),
    vertical: Number(format.height) > Number(format.width),
    pieces: pieces.map((p) => ({ start: round(p.start), end: round(p.end) })),
  }
}
