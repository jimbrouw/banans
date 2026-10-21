import { describe, expect, it } from 'vitest'
import { nextSequenceName, sourceBaseName, timeRange } from './sequenceNames'

describe('sourceBaseName', () => {
  it('strips RoughCut suffixes, current and legacy, however many', () => {
    expect(sourceBaseName('Sequence 01')).toBe('Sequence 01')
    expect(sourceBaseName('Sequence 01 — Auto Cut 03 (Balanced · 41 cuts)')).toBe('Sequence 01')
    expect(sourceBaseName('Sequence 01 - Auto Cut - Auto Cut')).toBe('Sequence 01')
    expect(sourceBaseName('EDIT V2 - RoughCut')).toBe('EDIT V2')
    expect(sourceBaseName('Ep 4 — Clean-up 01 — Cold Open 02 (0:42–1:10)')).toBe('Ep 4')
  })

  it('leaves names that only look similar alone', () => {
    expect(sourceBaseName('Interview — part 2')).toBe('Interview — part 2')
    expect(sourceBaseName('Auto Cut')).toBe('Auto Cut')
  })
})

describe('nextSequenceName', () => {
  const existing = [
    'Sequence 01',
    'Sequence 01 — Auto Cut 01 (Balanced · 30 cuts)',
    'Sequence 01 — Auto Cut 02 (Dynamic · 61 cuts · mics)',
    'Sequence 01 — Clean-up 01 (9 cuts · 12.0s)',
    'Sequence 02 — Auto Cut 07',
  ]

  it('numbers runs per source and action', () => {
    expect(nextSequenceName('Sequence 01', 'Auto Cut', 'Balanced · 41 cuts · mics', existing)).toBe('Sequence 01 — Auto Cut 03 (Balanced · 41 cuts · mics)')
    expect(nextSequenceName('Sequence 01', 'Clean-up', '12 cuts · 18.4s', existing)).toBe('Sequence 01 — Clean-up 02 (12 cuts · 18.4s)')
    expect(nextSequenceName('Sequence 01', 'Cold Open', timeRange(42, 70), existing)).toBe('Sequence 01 — Cold Open 01 (0:42–1:10)')
  })

  it('counts against the original when run on a generated sequence', () => {
    expect(nextSequenceName('Sequence 01 — Clean-up 01 (9 cuts · 12.0s)', 'Auto Cut', '', existing)).toBe('Sequence 01 — Auto Cut 03')
  })
})
