/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { XMLParser } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { applyCutsToXml, keepRanges } from './xmlCut'

// 25 fps, 100 frames. V1: clip A 0–60 (src 1000–1060) + transition + clip B 60–100 (src 0–40, start -1).
// A1: audio for A, linked to the video. One sequence marker at frame 30.
const clipV = (id: string, start: number, end: number, inn: number, out: number, file: string, link = '') => `
        <clipitem id="${id}">
          <name>${id}</name><enabled>TRUE</enabled><duration>5000</duration>
          <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
          <start>${start}</start><end>${end}</end><in>${inn}</in><out>${out}</out>
          <pproTicksIn>${inn * 10160640000}</pproTicksIn><pproTicksOut>${out * 10160640000}</pproTicksOut>
          ${file}${link}
        </clipitem>`
const fileDef = `<file id="file-1"><name>a.mov</name><pathurl>file:///Users/me/a%20b.mov</pathurl><duration>5000</duration></file>`
const link = (ref: string, type: string, track: number) => `<link><linkclipref>${ref}</linkclipref><mediatype>${type}</mediatype><trackindex>${track}</trackindex><clipindex>1</clipindex></link>`

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <uuid>abc</uuid>
    <duration>100</duration>
    <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
    <name>Talk</name>
    <media>
      <video>
        <track>${clipV('clipitem-1', 0, 60, 1000, 1060, fileDef, link('clipitem-1', 'video', 1) + link('clipitem-3', 'audio', 1))}
          <transitionitem><start>58</start><end>62</end></transitionitem>${clipV('clipitem-2', -1, 100, 2000, 2040, '<file id="file-1"/>')}
        </track>
      </video>
      <audio>
        <track>${clipV('clipitem-3', 0, 60, 1000, 1060, '<file id="file-1"/>', link('clipitem-1', 'video', 1) + link('clipitem-3', 'audio', 1))}
        </track>
      </audio>
    </media>
    <marker><name>m</name><in>30</in><out>-1</out></marker>
    <marker><name>gone</name><in>12</in><out>-1</out></marker>
  </sequence>
</xmeml>
`

type Rec = Record<string, unknown>
const parse = (xml: string) => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => ['track', 'clipitem', 'marker', 'link'].includes(n) }).parse(xml) as Rec
const seqOf = (xml: string) => (parse(xml).xmeml as Rec).sequence as Rec
const items = (seq: Rec, kind: 'video' | 'audio') => (((seq.media as Rec)[kind] as Rec).track as Rec[]).flatMap((t) => (t.clipitem as Rec[]) ?? [])

describe('keepRanges', () => {
  it('complements the cuts and places each kept range on the new timeline', () => {
    expect(keepRanges([{ start: 0.4, end: 0.8 }, { start: 2, end: 2.4 }], 25, 100)).toEqual([
      { start: 0, end: 10, outStart: 0 },
      { start: 20, end: 50, outStart: 10 },
      { start: 60, end: 100, outStart: 40 },
    ])
  })

  it('merges overlapping cuts and clamps to the sequence', () => {
    expect(keepRanges([{ start: 1, end: 2 }, { start: 1.5, end: 3 }, { start: 3.8, end: 9 }], 25, 100)).toEqual([
      { start: 0, end: 25, outStart: 0 },
      { start: 75, end: 95, outStart: 25 },
    ])
  })
})

describe('applyCutsToXml', () => {
  // Cut frames 10–20 (inside clip A) and 55–65 (across the A/B edit and the transition).
  const { xml, stats } = applyCutsToXml(SAMPLE, [{ start: 0.4, end: 0.8 }, { start: 2.2, end: 2.6 }], 'Talk - RoughCut')
  const seq = seqOf(xml)

  it('keeps the prolog and renames the sequence with a fresh uuid', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml')).toBe(true)
    expect(seq.name).toBe('Talk - RoughCut')
    expect(seq.uuid).toBeUndefined()
  })

  it('splits clips at the cuts and closes the gaps', () => {
    expect(stats).toMatchObject({ originalFrames: 100, newFrames: 80, removedFrames: 20, transitionsDropped: 1 })
    expect(seq.duration).toBe(80)
    const v = items(seq, 'video').map((c) => [c['@_id'], c.start, c.end, c.in, c.out])
    expect(v).toEqual([
      ['clipitem-1-0', 0, 10, 1000, 1010],
      ['clipitem-1-1', 10, 45, 1020, 1055],
      ['clipitem-2-2', 45, 80, 2005, 2040], // start -1 resolved to 60, then trimmed by the 55–65 cut
    ])
  })

  it('keeps audio cut identically to its video', () => {
    const a = items(seq, 'audio').map((c) => [c['@_id'], c.start, c.end, c.in, c.out])
    expect(a).toEqual([['clipitem-3-0', 0, 10, 1000, 1010], ['clipitem-3-1', 10, 45, 1020, 1055]])
  })

  it('re-times pproTicks with the clip', () => {
    const second = items(seq, 'video')[1]
    expect(second.pproTicksIn).toBe(1020 * 10160640000)
    expect(second.pproTicksOut).toBe(1055 * 10160640000)
  })

  it('points links at the matching piece', () => {
    const v1 = items(seq, 'video')[1]
    expect((v1.link as Rec[]).map((l) => l.linkclipref)).toEqual(['clipitem-1-1', 'clipitem-3-1'])
    expect(items(seq, 'video')[2].link).toBeUndefined()
  })

  it('gives the first use of each file the full definition and later uses a reference', () => {
    const files = [...items(seq, 'video'), ...items(seq, 'audio')].map((c) => c.file as Rec)
    expect(files[0].pathurl).toBe('file:///Users/me/a%20b.mov')
    expect(files.slice(1).every((f) => f['@_id'] === 'file-1' && f.pathurl === undefined)).toBe(true)
  })

  it('moves sequence markers with the edit and drops ones inside a cut', () => {
    expect(seq.marker).toEqual([{ name: 'm', in: 20, out: -1 }])
    expect(stats.markersDropped).toBe(1)
  })

  it('hands the full file definition to a later piece when the first clip is cut away', () => {
    const { xml: out } = applyCutsToXml(SAMPLE, [{ start: 0, end: 2.4 }], 'x')
    const first = items(seqOf(out), 'video')[0]
    expect(first['@_id']).toBe('clipitem-2-0')
    expect((first.file as Rec).pathurl).toBe('file:///Users/me/a%20b.mov')
  })

  it('returns an unchanged edit when there are no cuts', () => {
    const { stats: s } = applyCutsToXml(SAMPLE, [], 'same')
    expect(s.removedFrames).toBe(0)
  })

  it('places a clip with fades on both ends from the neighbouring transitions', () => {
    const music = SAMPLE.replace('<audio>', `<audio>
        <track>
          <transitionitem><start>0</start><end>10</end><alignment>start-black</alignment></transitionitem>${clipV('clipitem-9', -1, -1, 500, 580, '<file id="file-1"/>')}
          <transitionitem><start>70</start><end>80</end><alignment>end-black</alignment></transitionitem>
        </track>`)
    const { xml: out, stats: s } = applyCutsToXml(music, [{ start: 0.4, end: 0.8 }], 'x')
    expect(s.unplaced).toEqual([])
    const bed = items(seqOf(out), 'audio').filter((c) => String(c['@_id']).startsWith('clipitem-9'))
    expect(bed.map((c) => [c.start, c.end, c.in, c.out])).toEqual([[0, 10, 500, 510], [10, 70, 520, 580]])
  })

  it('keeps a clip it cannot place instead of dropping it', () => {
    const lost = SAMPLE.replace('<audio>', `<audio><track>${clipV('clipitem-8', -1, -1, 0, 10, '<file id="file-1"/>')}</track>`)
    const { xml: out, stats: s } = applyCutsToXml(lost, [], 'x')
    expect(s.unplaced).toEqual(['clipitem-8'])
    expect(items(seqOf(out), 'audio').some((c) => c['@_id'] === 'clipitem-8')).toBe(true)
  })

  it('rejects non-xmeml input', () => {
    expect(() => applyCutsToXml('<fcpxml/>', [], 'x')).toThrow('Not an FCP XML')
  })
})

// The real Premiere export used by the eval harness (gitignored, local only).
const REAL = 'EDIT V2 xlm for test .xml'
describe.skipIf(!existsSync(REAL))('applyCutsToXml on a real Premiere export', () => {
  const xml = readFileSync(REAL, 'utf8')
  const cuts = Array.from({ length: 40 }, (_, i) => ({ start: 30 + i * 60, end: 31.5 + i * 60 }))
  const { xml: out, stats } = applyCutsToXml(xml, cuts, 'EDIT V2 - RoughCut')
  const seq = seqOf(out)
  const all = [...items(seq, 'video'), ...items(seq, 'audio')]

  it('removes exactly the cut frames', () => {
    const fps = 24000 / 1001
    const expected = cuts.reduce((sum, c) => sum + Math.round(c.end * fps) - Math.round(c.start * fps), 0)
    expect(stats.removedFrames).toBe(expected)
    expect(seq.duration).toBe(stats.newFrames)
  })

  it('every clip fits the new timeline and keeps source length = timeline length', () => {
    for (const c of all) {
      const start = c.start as number; const end = c.end as number
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeLessThanOrEqual(stats.newFrames)
      expect(end - start).toBeGreaterThan(0)
      if (typeof c.in === 'number') expect((c.out as number) - c.in).toBe(end - start)
    }
  })

  it('defines every referenced file before (or where) it is first used', () => {
    const defined = new Set<string>()
    for (const t of ['video', 'audio'] as const) {
      for (const c of items(seq, t)) {
        const f = c.file as Rec | undefined
        if (!f) continue
        // A definition has child elements (pathurl for media files, mediaSource for generated ones).
        if (Object.keys(f).some((k) => !k.startsWith('@_'))) defined.add(f['@_id'] as string)
        expect(defined.has(f['@_id'] as string)).toBe(true)
      }
    }
  })

  it('places every clip and loses none outside the cuts', () => {
    expect(stats.unplaced).toEqual([])
    const fps = 24000 / 1001
    const cutFrames = cuts.map((c) => [Math.round(c.start * fps), Math.round(c.end * fps)])
    const outIds = new Set(all.map((c) => String(c['@_id']).replace(/-\d+$/, '')))
    const original = seqOf(xml)
    for (const c of [...items(original, 'video'), ...items(original, 'audio')]) {
      const s = c.start as number; const e = c.end as number
      const insideCut = s >= 0 && e >= 0 && cutFrames.some(([a, b]) => s >= a && e <= b)
      if (!insideCut) expect(outIds.has(c['@_id'] as string), `${c['@_id']} ${c.name}`).toBe(true)
    }
  })

  it('has unique clip ids', () => {
    const ids = all.map((c) => c['@_id'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
