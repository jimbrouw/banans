/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readReferenceClip } from './clipReference'
import { scoreSelects, union } from './selectsEval'

const clipXml = (name: string, pieces: { start: number; end: number; inn: number; out: number }[], clipName = 'Episode') => `<?xml version="1.0"?>
<xmeml version="4"><sequence><name>${name}</name><duration>900</duration><rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
<media><video><format><samplecharacteristics><width>1080</width><height>1920</height></samplecharacteristics></format></video>
<audio><track>${pieces.map((p, i) => `<clipitem id="c${i}"><name>${clipName}</name><rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate><start>${p.start}</start><end>${p.end}</end><in>${p.inn}</in><out>${p.out}</out></clipitem>`).join('')}
<clipitem id="m"><name>music.wav</name><start>0</start><end>900</end><in>0</in><out>900</out></clipitem></track></audio></media></sequence></xmeml>`

describe('readReferenceClip', () => {
  it('returns episode-time pieces in play order, merging continuous ones', () => {
    // A hook from 100 s pulled to the front, then 60–70 s and 70–80 s (continuous), then 90–95 s.
    const xml = clipXml('Short A', [
      { start: 0, end: 90, inn: 3000, out: 3090 },
      { start: 90, end: 390, inn: 1800, out: 2100 },
      { start: 390, end: 690, inn: 2100, out: 2400 },
      { start: 690, end: 840, inn: 2700, out: 2850 },
    ])
    const ref = readReferenceClip(xml, (n) => n === 'Episode')
    expect(ref).toEqual({ name: 'Short A', durationSeconds: 30, vertical: true, pieces: [{ start: 100, end: 103 }, { start: 60, end: 80 }, { start: 90, end: 95 }] })
  })

  it('says when nothing in the clip comes from the episode', () => {
    expect(() => readReferenceClip(clipXml('B', [{ start: 0, end: 30, inn: 0, out: 30 }], 'Other'), (n) => n === 'Episode')).toThrow('comes from the episode')
  })
})

describe('scoreSelects', () => {
  const ref = { name: 'Short A', durationSeconds: 30, vertical: true, pieces: [{ start: 100, end: 103 }, { start: 60, end: 80 }, { start: 90, end: 95 }] }

  it('finds the editor clip, ranks it, and measures edges and opening', () => {
    const score = scoreSelects([
      { title: 'other', pieces: [{ start: 500, end: 540 }] },
      { title: 'close', pieces: [{ start: 58, end: 96 }] },
    ], [ref])
    expect(score.found).toBe(1)
    expect(score.matches[0]).toMatchObject({ found: true, rank: 2, coverage: 0.89, startError: 2, endError: 7, sameOpening: false })
  })

  it('credits a pick that pulls the same hook forward', () => {
    const score = scoreSelects([{ title: 'same', pieces: [{ start: 99, end: 103 }, { start: 60, end: 95 }] }], [ref])
    expect(score.matches[0]).toMatchObject({ found: true, rank: 1, sameOpening: true })
  })

  it('does not count a pick that barely touches the clip', () => {
    expect(scoreSelects([{ title: 'edge', pieces: [{ start: 78, end: 120 }] }], [ref]).matches[0].found).toBe(false)
    expect(union([{ start: 5, end: 9 }, { start: 1, end: 6 }])).toEqual([{ start: 1, end: 9 }])
  })
})

// The editor's real published clips for the Kate Courtney episode (gitignored, local only).
const DIR = 'xlr social clips'
const isEpisode = (n: string) => n === 'Kate Courtney v1' || n.startsWith('Kate Courtney v1.prproj_mixdown')
describe.skipIf(!existsSync(DIR))('reference clips from the Kate Courtney episode', () => {
  it('reads both published Shorts in episode time', () => {
    const one = readReferenceClip(readFileSync(`${DIR}/SOCAIL CLIP 1 KC.xml`, 'utf8'), isEpisode)
    const two = readReferenceClip(readFileSync(`${DIR}/Sequence 07.xml`, 'utf8'), isEpisode)
    expect(one).toMatchObject({ durationSeconds: 34.1, vertical: true })
    expect(one.pieces).toHaveLength(1)
    expect(one.pieces[0].start).toBeCloseTo(3191.07, 0)
    expect(two.durationSeconds).toBeCloseTo(58.33, 1)
    expect(two.pieces[0].start).toBeCloseTo(2705.3, 0) // the hook at 45:05, pulled to the front
    expect(two.pieces[1].start).toBeCloseTo(2671.9, 0) // then back to 44:32
  })
})
