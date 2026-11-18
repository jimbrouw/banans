import { describe, expect, it } from 'vitest'
import { evaluateRun, formatReport } from './evaluate'
import { makeEpisode } from './fixtures'

describe('synthetic podcast baseline scorecards', () => {
  it.each([10, 30, 60] as const)('%i-minute episode', (minutes) => {
    const report = evaluateRun(makeEpisode(minutes))
    console.log(`\n${formatReport(report)}\n`)
    expect(report.pass).toBe(true)
  })
})
