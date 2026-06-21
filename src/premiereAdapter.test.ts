import { describe, expect, it } from 'vitest'
import { normalizeTranscriptJson } from './premiereAdapter'

describe('normalizeTranscriptJson', () => {
  it('normalizes segment transcripts and applies the timeline offset', () => {
    const result = normalizeTranscriptJson(JSON.stringify({ segments: [{ id: 'a', speaker: 'Guest', start: 2, end: 5, text: 'A useful answer', confidence: .91 }] }), 10)
    expect(result).toEqual([{ id: 'a', speaker: 'Guest', start: 12, end: 15, text: 'A useful answer', confidence: .91 }])
  })

  it('builds a segment from word-level timing', () => {
    const result = normalizeTranscriptJson(JSON.stringify({ segments: [{ speaker: 'Host', words: [{ text: 'Hello', start: 1, duration: .4 }, { text: 'there', start: 1.4, duration: .6 }] }] }))
    expect(result[0]).toMatchObject({ speaker: 'Host', start: 1, end: 2, text: 'Hello there' })
  })

  it('ignores malformed entries instead of writing invalid markers', () => {
    expect(normalizeTranscriptJson(JSON.stringify({ segments: [{ speaker: 'Host' }, null, 'bad'] }))).toEqual([])
  })
})
