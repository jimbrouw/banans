import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatLogLine, logged } from './runLog'

const at = new Date(2026, 9, 21, 15, 2, 11)

describe('formatLogLine', () => {
  it('reads as one line: time, status, action, duration, result, details', () => {
    expect(formatLogLine({ at, status: 'OK', action: 'Auto Cut', ms: 4210, result: 'Sequence 01 — Auto Cut 03 (Balanced)', details: { source: 'Sequence 01', cuts: 41, empty: '', skip: undefined } }))
      .toBe('2026-10-21 15:02:11  OK    Auto Cut             4.2s  "Sequence 01 — Auto Cut 03 (Balanced)"  source="Sequence 01"  cuts=41')
  })

  it('keeps errors on the same line', () => {
    expect(formatLogLine({ at, status: 'FAIL', action: 'Clean-up', ms: 300, details: { error: 'Premiere could not "import"' } }))
      .toBe('2026-10-21 15:02:11  FAIL  Clean-up             0.3s  error="Premiere could not \\"import\\""')
  })
})

describe('logged', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes results and errors through, logging each', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(await logged('Detect cameras', { n: 1 }, async () => 3, (r) => `${r} cameras`)).toBe(3)
    await expect(logged('Auto Cut', {}, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await new Promise((r) => setTimeout(r, 0))
    const lines = info.mock.calls.map((c) => String(c[0]))
    expect(lines[0]).toMatch(/OK {4}Detect cameras .* "3 cameras" {2}n=1$/)
    expect(lines[1]).toMatch(/FAIL {2}Auto Cut .* error="boom"$/)
  })
})
