import { describe, expect, it } from 'vitest'
import { normalizeTranscriptJson, parseTranscriptFile } from './transcriptParse'

describe('normalizeTranscriptJson speaker resolution', () => {
  it('resolves speaker UUID references to speaker names', () => {
    const json = JSON.stringify({
      speakers: [{ id: 'uuid-1', name: 'Gary Fisher' }],
      segments: [{ speaker: 'uuid-1', start: 1, end: 2, text: 'Hello' }],
    })
    expect(normalizeTranscriptJson(json)[0].speaker).toBe('Gary Fisher')
  })

  it('keeps literal speaker labels when no speakers array is present', () => {
    const json = JSON.stringify({ segments: [{ speaker: 'Host', start: 1, end: 2, text: 'Hi' }] })
    expect(normalizeTranscriptJson(json)[0].speaker).toBe('Host')
  })

  it('joins word tokens without spacing before punctuation', () => {
    const json = JSON.stringify({ segments: [{ speaker: 'Host', words: [
      { text: 'Hello', start: 1, duration: .4, type: 'word' },
      { text: ',', start: 1.4, duration: 0, type: 'punctuation' },
      { text: 'world', start: 1.4, duration: .5, type: 'word' },
      { text: '.', start: 1.9, duration: 0, type: 'punctuation' },
    ] }] })
    expect(normalizeTranscriptJson(json)[0].text).toBe('Hello, world.')
  })
})

describe('parseTranscriptFile', () => {
  it('parses an SRT file with embedded speaker labels and millisecond timing', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,500\nSpeaker 2: It was my first race.\n\n2\n00:00:05,000 --> 00:00:06,000\nRight.'
    const result = parseTranscriptFile(srt, 'clip.srt')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ speaker: 'Speaker 2', start: 1, end: 4.5, text: 'It was my first race.' })
    expect(result[1]).toMatchObject({ speaker: 'Unknown', start: 5, text: 'Right.' })
  })

  it('parses a CSV file with speaker, timecode, and text columns', () => {
    const csv = 'Speaker,Start,End,Text\nGary,00:00:10:00,00:00:12:00,"Hello, there"\nHost,00:00:13:00,00:00:14:00,Welcome'
    const result = parseTranscriptFile(csv, 'export.csv', 30)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ speaker: 'Gary', start: 10, end: 12, text: 'Hello, there' })
  })

  it('treats .prtranscript content as JSON', () => {
    const json = JSON.stringify({ speakers: [{ id: 's1', name: 'Guest' }], segments: [{ speaker: 's1', start: 0, end: 1, text: 'Yes' }] })
    const result = parseTranscriptFile(json, 'sequence.prtranscript')
    expect(result[0]).toMatchObject({ speaker: 'Guest', text: 'Yes' })
  })
})
