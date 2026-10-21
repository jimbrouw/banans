import { describe, expect, it } from 'vitest'
import { buildCuts, cutsToDecisions, defaultReviewSettings, gapSilences, groupLines, mapToSequence, speechUnits, summarise, wordsForClip } from './reviewModel'
import type { ReviewWord } from './reviewModel'

const w = (text: string, start: number, end: number, filler = false, segment = '0:0'): ReviewWord => ({ text, start, end, filler, segment })
const noPad = { ...defaultReviewSettings, padding: 0 }

describe('mapToSequence', () => {
  const clip = { path: '/a.mov', start: 10, end: 20, inPoint: 100 } // source 100–110 plays at sequence 10–20

  it('shifts source time to sequence time', () => {
    expect(mapToSequence([{ start: 101, end: 102.5 }], clip)).toEqual([{ start: 11, end: 12.5 }])
  })

  it('drops items outside the used source window and clamps edge items', () => {
    const out = mapToSequence([{ start: 50, end: 51 }, { start: 99.8, end: 100.6 }, { start: 109.5, end: 110.4 }, { start: 120, end: 121 }], clip)
    expect(out).toEqual([{ start: 10, end: 10.6 }, { start: 19.5, end: 20 }])
  })

  it('tags words with a per-clip segment id', () => {
    const words = [{ text: 'hi', start: 101, end: 101.2, prob: 1, filler: false, segment: 3 }]
    expect(wordsForClip(words, clip, 2)).toEqual([{ text: 'hi', start: 11, end: 11.2, filler: false, segment: '2:3' }])
  })
})

describe('buildCuts', () => {
  it('pads silences so word edges are not clipped', () => {
    const cuts = buildCuts([], [{ start: 1, end: 2 }], { ...defaultReviewSettings, padding: 0.1 })
    expect(cuts).toMatchObject([{ start: 1.1, end: 1.9, reasons: ['silence'], label: 'Pause 0.8s', active: true }])
  })

  it('ignores silences shorter than the minimum', () => {
    expect(buildCuts([], [{ start: 1, end: 1.4 }], { ...noPad, minSilence: 0.6 })).toEqual([])
  })

  it('never cuts through a spoken word inside a detected silence', () => {
    const cuts = buildCuts([w('quiet', 1.4, 1.6)], [{ start: 1, end: 2 }], noPad)
    expect(cuts.map((c) => [c.start, c.end])).toEqual([[1, 1.4], [1.6, 2]])
  })

  it('cuts fillers and merges them with an adjacent pause', () => {
    const words = [w('So', 0, 0.3), w('um,', 0.5, 0.8, true), w('right', 2, 2.3)]
    const cuts = buildCuts(words, [{ start: 0.8, end: 2 }], noPad)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toMatchObject({ start: 0.5, end: 2, label: 'Pause + filler "um" · 1.5s' })
    expect(cuts[0].reasons.sort()).toEqual(['filler', 'silence'])
  })

  it('leaves fillers alone when filler cutting is off', () => {
    expect(buildCuts([w('uh', 1, 1.3, true)], [], { ...noPad, cutFillers: false })).toEqual([])
  })
})

describe('groupLines / summarise / cutsToDecisions', () => {
  it('groups words by segment in time order', () => {
    const lines = groupLines([w('b', 1, 1.2, false, '0:0'), w('a', 0, 0.2, false, '0:0'), w('c', 3, 3.2, false, '0:1')])
    expect(lines.map((l) => [l.id, l.words.map((x) => x.text).join(' '), l.start, l.end])).toEqual([['0:0', 'a b', 0, 1.2], ['0:1', 'c', 3, 3.2]])
  })

  it('counts only active cuts and turns them into trim markers', () => {
    const cuts = buildCuts([], [{ start: 1, end: 2 }, { start: 5, end: 6.5 }], noPad)
    cuts[1].active = false
    expect(summarise(cuts)).toEqual({ count: 1, seconds: 1 })
    expect(cutsToDecisions(cuts)).toEqual([{ id: 'cut-0', start: 1, end: 2, type: 'suggested_trim', label: 'Pause 1.0s', detail: 'RoughCut review: silence', confidence: 1, selected: true }])
  })
})

describe('speechUnits', () => {
  it('splits at sentence ends, segment changes and long gaps', () => {
    const words = [
      w('So', 0, 0.2), w('the,', 0.3, 0.5), w('okay.', 0.6, 0.9),
      w('Today', 1.0, 1.3), w('we', 1.4, 1.5), w('talk', 2.6, 2.9),
      w('Next', 3.0, 3.2, false, '0:1'), w('one?"', 3.3, 3.6, false, '0:1'),
    ]
    expect(speechUnits(words)).toEqual([
      { id: 0, start: 0, end: 0.9, text: 'So the, okay.' },
      { id: 1, start: 1.0, end: 1.5, text: 'Today we' },
      { id: 2, start: 2.6, end: 2.9, text: 'talk' },
      { id: 3, start: 3.0, end: 3.6, text: 'Next one?"' },
    ])
  })
})

describe('buildCuts with AI removals', () => {
  it('labels AI cuts with reason and note, and merges them with an adjacent pause', () => {
    const cuts = buildCuts([w('Let', 10, 10.2), w('me,', 10.3, 10.6)], [{ start: 10.6, end: 11.5 }], noPad, [
      { start: 10, end: 10.6, reason: 'false_start', note: 'restarted; kept line 4' },
    ])
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toMatchObject({ start: 10, end: 11.5, label: 'False start · 1.5s · restarted; kept line 4' })
    expect(cuts[0].reasons.sort()).toEqual(['false_start', 'silence'])
  })
})

describe('gapSilences', () => {
  it('turns gaps between words into pauses', () => {
    expect(gapSilences([w('c', 3, 3.5), w('a', 0, 1), w('b', 1.1, 2)], 0.3)).toEqual([{ start: 2, end: 3 }])
  })
})
