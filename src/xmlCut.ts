// Remove time ranges from a Premiere-exported FCP7 XML (xmeml) sequence.
//
// Pure string → string. The panel exports the active sequence with
// exportAsFinalCutProXML, runs this, and imports the result as a new sequence,
// so every track, file reference and effect comes from Premiere's own export.
//
// Every clip on every track is split at the kept ranges and closed up, so
// video and audio stay in sync. Known limits (v1):
//   - Transitions are dropped (a cut can land inside one).
//   - Keyframes inside a clip aren't re-timed when the clip is split.
//   - Only the top-level sequence is edited; nested sequences are left as is.

import { XMLBuilder, XMLParser } from 'fast-xml-parser'

type XNode = Record<string, unknown>

const OPTS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  suppressEmptyNode: true,
} as const

export interface CutRangeSeconds { start: number; end: number }
export interface XmlCutStats {
  fps: number
  originalFrames: number
  newFrames: number
  removedFrames: number
  clipPieces: number
  transitionsDropped: number
  markersDropped: number
}

// ── preserveOrder node helpers ────────────────────────────────────────────────

const tagOf = (n: XNode) => Object.keys(n).find((k) => k !== ':@') ?? ''
const kids = (n: XNode) => (n[tagOf(n)] as XNode[]) ?? []
const child = (n: XNode, name: string) => kids(n).find((c) => tagOf(c) === name)
const childrenNamed = (n: XNode, name: string) => kids(n).filter((c) => tagOf(c) === name)
const attr = (n: XNode, name: string) => (n[':@'] as Record<string, string> | undefined)?.[`@_${name}`]
const setAttr = (n: XNode, name: string, value: string) => { n[':@'] = { ...(n[':@'] as object), [`@_${name}`]: value } }
const textOf = (n: XNode | undefined) => (n ? kids(n).map((c) => (c['#text'] as string) ?? '').join('').trim() : '')
const getText = (n: XNode, name: string) => textOf(child(n, name))
const getNum = (n: XNode, name: string) => Number(getText(n, name))
const setText = (n: XNode, name: string, value: string | number) => { const c = child(n, name); if (c) c[tagOf(c)] = [{ '#text': String(value) }] }
const isElement = (n: XNode) => !('#text' in n) && !('#comment' in n)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function rateOf(n: XNode): { timebase: number; fps: number } {
  const rate = child(n, 'rate')
  const timebase = rate ? getNum(rate, 'timebase') : NaN
  const ntsc = rate ? getText(rate, 'ntsc').toUpperCase() === 'TRUE' : false
  return { timebase, fps: ntsc ? timebase * 1000 / 1001 : timebase }
}

// ── keep ranges ───────────────────────────────────────────────────────────────

interface Keep { start: number; end: number; outStart: number } // frames

/** Cuts in seconds → the frame ranges to keep, each with its position in the new timeline. */
export function keepRanges(cuts: CutRangeSeconds[], fps: number, totalFrames: number): Keep[] {
  const frameCuts = cuts
    .map((c) => ({ start: Math.max(0, Math.round(c.start * fps)), end: Math.min(totalFrames, Math.round(c.end * fps)) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start)
  const keeps: Keep[] = []
  let cursor = 0
  let out = 0
  const push = (start: number, end: number) => { if (end > start) { keeps.push({ start, end, outStart: out }); out += end - start } }
  for (const c of frameCuts) {
    push(cursor, c.start)
    cursor = Math.max(cursor, c.end)
  }
  push(cursor, totalFrames)
  return keeps
}

// ── clip splitting ────────────────────────────────────────────────────────────

function resolvedSpan(item: XNode): { start: number; end: number } {
  let start = getNum(item, 'start')
  let end = getNum(item, 'end')
  const len = getNum(item, 'out') - getNum(item, 'in')
  // -1 means "inside a transition"; transitions are dropped, so derive it from the source length.
  if (start < 0 && end >= 0) start = end - len
  if (end < 0 && start >= 0) end = start + len
  return { start, end }
}

function splitItem(item: XNode, keeps: Keep[], seqFps: number): { piece: XNode; keepIndex: number }[] {
  const { start, end } = resolvedSpan(item)
  if (!(end > start)) return []
  const hasSource = child(item, 'in') !== undefined && child(item, 'out') !== undefined
  const srcIn = getNum(item, 'in')
  const ratio = rateOf(item).fps / seqFps || 1 // source frames per sequence frame
  const ticksIn = Number(getText(item, 'pproTicksIn'))
  const ticksOut = Number(getText(item, 'pproTicksOut'))
  const srcLen = getNum(item, 'out') - srcIn
  const ticksPerFrame = srcLen > 0 && Number.isFinite(ticksIn) && Number.isFinite(ticksOut) ? (ticksOut - ticksIn) / srcLen : NaN
  const id = attr(item, 'id')

  const pieces: { piece: XNode; keepIndex: number }[] = []
  keeps.forEach((k, keepIndex) => {
    const s = Math.max(start, k.start)
    const e = Math.min(end, k.end)
    if (e <= s) return
    const piece = clone(item)
    if (id) setAttr(piece, 'id', `${id}-${keepIndex}`)
    const newStart = k.outStart + (s - k.start)
    setText(piece, 'start', newStart)
    setText(piece, 'end', newStart + (e - s))
    if (hasSource) {
      const newIn = srcIn + Math.round((s - start) * ratio)
      const newOut = newIn + Math.round((e - s) * ratio)
      setText(piece, 'in', newIn)
      setText(piece, 'out', newOut)
      if (Number.isFinite(ticksPerFrame)) {
        setText(piece, 'pproTicksIn', Math.round(ticksIn + (newIn - srcIn) * ticksPerFrame))
        setText(piece, 'pproTicksOut', Math.round(ticksIn + (newOut - srcIn) * ticksPerFrame))
      }
    }
    pieces.push({ piece, keepIndex })
  })
  return pieces
}

// ── document-level fixes ──────────────────────────────────────────────────────

const ITEM_TAGS = new Set(['clipitem', 'generatoritem'])

/** First use of each file id must carry the full definition; later uses are bare references. */
function fixFileDefinitions(tracks: XNode[], fullDefs: Map<string, XNode>) {
  const defined = new Set<string>()
  for (const track of tracks) {
    for (const item of kids(track).filter((c) => ITEM_TAGS.has(tagOf(c)))) {
      const list = kids(item)
      const i = list.findIndex((c) => tagOf(c) === 'file')
      if (i < 0) continue
      const fileId = attr(list[i], 'id')
      if (!fileId) continue
      if (!defined.has(fileId)) {
        const def = fullDefs.get(fileId)
        if (def) list[i] = clone(def)
        defined.add(fileId)
      } else {
        list[i] = { file: [], ':@': { '@_id': fileId } }
      }
    }
  }
}

/** Point links at the matching split piece; drop links whose partner was cut away. Re-number clipindex. */
function fixLinks(tracks: XNode[], idToKeep: Map<string, number>) {
  const liveIds = new Set<string>()
  const position = new Map<string, number>()
  for (const track of tracks) {
    kids(track).filter((c) => ITEM_TAGS.has(tagOf(c))).forEach((item, i) => {
      const id = attr(item, 'id')
      if (id) { liveIds.add(id); position.set(id, i + 1) }
    })
  }
  for (const track of tracks) {
    for (const item of kids(track).filter((c) => ITEM_TAGS.has(tagOf(c)))) {
      const keepIndex = idToKeep.get(attr(item, 'id') ?? '')
      const list = kids(item)
      item[tagOf(item)] = list.filter((c) => {
        if (tagOf(c) !== 'link') return true
        const target = `${getText(c, 'linkclipref')}-${keepIndex}`
        if (!liveIds.has(target)) return false
        setText(c, 'linkclipref', target)
        if (child(c, 'clipindex')) setText(c, 'clipindex', position.get(target) ?? 1)
        return true
      })
    }
  }
}

function shiftMarkers(seq: XNode, keeps: Keep[]): number {
  let dropped = 0
  seq[tagOf(seq)] = kids(seq).filter((m) => {
    if (tagOf(m) !== 'marker') return true
    const at = getNum(m, 'in')
    const k = keeps.find((r) => at >= r.start && at < r.end)
    if (!k) { dropped++; return false }
    const shift = k.outStart - k.start
    setText(m, 'in', at + shift)
    const out = getNum(m, 'out')
    if (out >= 0) setText(m, 'out', Math.min(out, k.end) + shift)
    return true
  })
  return dropped
}

// ── main entry ────────────────────────────────────────────────────────────────

export function applyCutsToXml(xml: string, cuts: CutRangeSeconds[], newName: string): { xml: string; stats: XmlCutStats } {
  const text = xml.replace(/^\uFEFF/, '')
  const rootAt = text.indexOf('<xmeml')
  if (rootAt < 0) throw new Error('Not an FCP XML (xmeml) file.')
  const prolog = text.slice(0, rootAt)
  const doc = new XMLParser(OPTS).parse(text.slice(rootAt)) as XNode[]
  const xmeml = doc.find((n) => tagOf(n) === 'xmeml')
  const seq = xmeml && child(xmeml, 'sequence')
  if (!seq) throw new Error('The XML has no sequence.')

  const { fps } = rateOf(seq)
  if (!(fps > 0)) throw new Error('Could not read the sequence frame rate from the XML.')
  const originalFrames = getNum(seq, 'duration')
  const keeps = keepRanges(cuts, fps, originalFrames)
  const media = child(seq, 'media')
  const tracks = media ? [...childrenNamed(child(media, 'video') ?? {}, 'track'), ...childrenNamed(child(media, 'audio') ?? {}, 'track')] : []

  // Remember each file's full definition before pieces get shuffled.
  const fullDefs = new Map<string, XNode>()
  for (const track of tracks) {
    for (const item of kids(track).filter((c) => ITEM_TAGS.has(tagOf(c)))) {
      const file = child(item, 'file')
      const fileId = file && attr(file, 'id')
      if (fileId && kids(file).some(isElement) && !fullDefs.has(fileId)) fullDefs.set(fileId, file)
    }
  }

  let clipPieces = 0
  let transitionsDropped = 0
  const idToKeep = new Map<string, number>()
  for (const track of tracks) {
    const next: XNode[] = []
    for (const node of kids(track)) {
      const tag = tagOf(node)
      if (tag === 'transitionitem') { transitionsDropped++; continue }
      if (!ITEM_TAGS.has(tag)) { next.push(node); continue }
      for (const { piece, keepIndex } of splitItem(node, keeps, fps)) {
        next.push(piece)
        clipPieces++
        const id = attr(piece, 'id')
        if (id) idToKeep.set(id, keepIndex)
      }
    }
    track[tagOf(track)] = next
  }

  fixFileDefinitions(tracks, fullDefs)
  fixLinks(tracks, idToKeep)
  const markersDropped = shiftMarkers(seq, keeps)

  const newFrames = keeps.reduce((sum, k) => sum + (k.end - k.start), 0)
  setText(seq, 'duration', newFrames)
  setText(seq, 'name', newName)
  seq[tagOf(seq)] = kids(seq).filter((c) => tagOf(c) !== 'uuid') // let Premiere assign a new one

  const body = new XMLBuilder(OPTS).build(doc) as string
  return {
    xml: prolog + body,
    stats: { fps, originalFrames, newFrames, removedFrames: originalFrames - newFrames, clipPieces, transitionsDropped, markersDropped },
  }
}
