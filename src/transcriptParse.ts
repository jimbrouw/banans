import type { TranscriptSegment } from './types'

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' ? value as JsonRecord : undefined

const numberField = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

const stringField = (record: JsonRecord, ...keys: string[]) => {
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string
  return undefined
}

// Joins word/punctuation tokens without inserting a space before punctuation,
// so reconstructed text reads "Hello, world." rather than "Hello , world .".
const joinWords = (words: JsonRecord[]) => {
  let text = ''
  for (const word of words) {
    const token = stringField(word, 'text', 'word')
    if (!token) continue
    const isPunctuation = word.type === 'punctuation' || /^[.,!?;:)\]}%'"…-]/.test(token)
    text += text && !isPunctuation ? ` ${token}` : token
  }
  return text.trim()
}

export function normalizeTranscriptJson(json: string, timelineOffset = 0): TranscriptSegment[] {
  const parsed = JSON.parse(json) as unknown
  const root = asRecord(parsed)
  if (!root) return []
  const candidates = [root.segments, root.transcript, root.items].find(Array.isArray)
  if (!Array.isArray(candidates)) return []

  const speakerNames = new Map<string, string>()
  if (Array.isArray(root.speakers)) {
    for (const entry of root.speakers) {
      const speaker = asRecord(entry)
      const id = speaker && stringField(speaker, 'id', 'guid', 'uuid')
      const name = speaker && stringField(speaker, 'name', 'label', 'displayName')
      if (id && name) speakerNames.set(id, name)
    }
  }

  return candidates.flatMap((candidate, index): TranscriptSegment[] => {
    const segment = asRecord(candidate)
    if (!segment) return []
    const words = Array.isArray(segment.words) ? segment.words.map(asRecord).filter(Boolean) as JsonRecord[] : []
    const firstWord = words[0]
    const lastWord = words.at(-1)
    const start = numberField(segment, 'start', 'startTime', 'start_time') ?? (firstWord && numberField(firstWord, 'start', 'startTime', 'start_time'))
    const explicitEnd = numberField(segment, 'end', 'endTime', 'end_time')
    const wordEnd = lastWord && (numberField(lastWord, 'end', 'endTime', 'end_time') ?? ((numberField(lastWord, 'start', 'startTime', 'start_time') ?? 0) + (numberField(lastWord, 'duration') ?? 0)))
    const end = explicitEnd ?? wordEnd ?? ((start ?? 0) + (numberField(segment, 'duration') ?? 0))
    const text = stringField(segment, 'text', 'transcript') ?? joinWords(words)
    if (start === undefined || !text) return []

    const speakerRef = stringField(segment, 'speaker', 'speakerName', 'speaker_label') ?? 'Unknown'
    return [{
      id: stringField(segment, 'id', 'guid') ?? `segment-${index}`,
      speaker: speakerNames.get(speakerRef) ?? speakerRef,
      start: Math.max(0, timelineOffset + start),
      end: Math.max(0, timelineOffset + end),
      text,
      confidence: numberField(segment, 'confidence', 'confidenceScore') ?? 1,
    }]
  })
}

export interface TranscriptWord { text: string; start: number; end: number; speaker: string; filler: boolean; segment: number }

// um/uh-style fillers only; "like"/"you know" depend on context (the AI pass handles those).
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'mhm'])

/**
 * Word-level view of a Premiere transcript JSON (Transcript.exportToJSON).
 * Punctuation tokens are attached to the word before them, so sentence ends
 * ("world.") survive for sentence splitting. Times are shifted by timelineOffset.
 */
export function transcriptWordsFromJson(json: string, timelineOffset = 0): TranscriptWord[] {
  const root = asRecord(JSON.parse(json) as unknown)
  if (!root) return []
  const candidates = [root.segments, root.transcript, root.items].find(Array.isArray)
  if (!Array.isArray(candidates)) return []
  const speakerNames = new Map<string, string>()
  if (Array.isArray(root.speakers)) {
    for (const entry of root.speakers) {
      const speaker = asRecord(entry)
      const id = speaker && stringField(speaker, 'id', 'guid', 'uuid')
      const name = speaker && stringField(speaker, 'name', 'label', 'displayName')
      if (id && name) speakerNames.set(id, name)
    }
  }

  const out: TranscriptWord[] = []
  candidates.forEach((candidate, segment) => {
    const seg = asRecord(candidate)
    if (!seg || !Array.isArray(seg.words)) return
    const ref = stringField(seg, 'speaker', 'speakerName', 'speaker_label') ?? 'Unknown'
    const speaker = speakerNames.get(ref) ?? ref
    for (const raw of seg.words) {
      const word = asRecord(raw)
      const text = word && stringField(word, 'text', 'word')?.trim()
      const start = word && numberField(word, 'start', 'startTime', 'start_time')
      if (!word || !text || start === undefined) continue
      const end = numberField(word, 'end', 'endTime', 'end_time') ?? start + (numberField(word, 'duration') ?? 0)
      const last = out[out.length - 1]
      if ((word.type === 'punctuation' || /^[.,!?;:)\]}%'"…-]+$/.test(text)) && last && last.segment === segment) {
        last.text += text
        continue
      }
      out.push({
        text,
        start: Math.max(0, timelineOffset + start),
        end: Math.max(0, timelineOffset + end),
        speaker,
        filler: FILLERS.has(text.toLowerCase().replace(/[^a-z]/g, '')),
        segment,
      })
    }
  })
  return out
}

// Premiere exports sequence timecodes either as float seconds, SRT-style
// HH:MM:SS,mmm, or HH:MM:SS:FF. Frame-based codes need a frame rate, so we
// approximate with the supplied fps (timeline markers are review hints, not cuts).
const timecodeToSeconds = (raw: string, fps: number): number | undefined => {
  const value = raw.trim()
  if (value === '') return undefined
  if (Number.isFinite(Number(value))) return Number(value)
  const match = value.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3})|:(\d{1,3}))?$/)
  if (!match) return undefined
  const [, h, m, s, millis, frames] = match
  let seconds = Number(h) * 3600 + Number(m) * 60 + Number(s)
  if (millis !== undefined) seconds += Number(`0.${millis.padEnd(3, '0')}`)
  else if (frames !== undefined && fps > 0) seconds += Number(frames) / fps
  return seconds
}

const splitCsvLine = (line: string): string[] => {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i += 1 } else quoted = !quoted
    } else if (char === ',' && !quoted) { cells.push(cell); cell = '' } else cell += char
  }
  cells.push(cell)
  return cells.map((value) => value.trim())
}

function parseCsv(content: string, fps: number): TranscriptSegment[] {
  const rows = content.replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '').map(splitCsvLine)
  if (rows.length < 2) return []
  const header = rows[0].map((value) => value.toLowerCase())
  const indexOf = (...needles: string[]) => header.findIndex((value) => needles.some((needle) => value.includes(needle)))
  const speakerIdx = indexOf('speaker', 'name')
  const startIdx = indexOf('start', 'in')
  const endIdx = indexOf('end', 'out')
  const textIdx = indexOf('text', 'transcript', 'content', 'caption', 'dialog')
  if (startIdx === -1 || textIdx === -1) return []

  return rows.slice(1).flatMap((cells, index): TranscriptSegment[] => {
    const text = cells[textIdx]?.trim()
    const start = timecodeToSeconds(cells[startIdx] ?? '', fps)
    if (!text || start === undefined) return []
    const end = (endIdx !== -1 && timecodeToSeconds(cells[endIdx] ?? '', fps)) || start
    return [{
      id: `csv-${index}`,
      speaker: (speakerIdx !== -1 && cells[speakerIdx]) || 'Unknown',
      start,
      end,
      text,
      confidence: 1,
    }]
  })
}

function parseSrt(content: string, fps: number): TranscriptSegment[] {
  const blocks = content.replace(/\r/g, '').split(/\n\s*\n/)
  return blocks.flatMap((block, index): TranscriptSegment[] => {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    const timingLine = lines.find((line) => line.includes('-->'))
    if (!timingLine) return []
    const [startRaw, endRaw] = timingLine.split('-->').map((value) => value.trim())
    const start = timecodeToSeconds(startRaw, fps)
    if (start === undefined) return []
    const end = timecodeToSeconds(endRaw ?? '', fps) ?? start
    let text = lines.filter((line) => line !== timingLine && !/^\d+$/.test(line.trim())).join(' ').trim()
    if (!text) return []

    let speaker = 'Unknown'
    const speakerMatch = text.match(/^(?:\[([^\]]{1,40})\]|([A-Za-z][\w .'-]{0,39}?)\s*:)\s*/)
    if (speakerMatch) {
      speaker = (speakerMatch[1] ?? speakerMatch[2]).trim()
      text = text.slice(speakerMatch[0].length).trim()
    }
    if (!text) return []
    return [{ id: `srt-${index}`, speaker, start, end, text, confidence: 1 }]
  })
}

// Parses an editor-exported transcript file. JSON is lossless; SRT and CSV are
// best-effort (frame-based timecodes use the supplied fps). Premiere's own
// ".prtranscript" is a proprietary container, not third-party readable — use
// "Export to CSV File" instead.
export function parseTranscriptFile(content: string, fileName: string, fps = 30): TranscriptSegment[] {
  const trimmed = content.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return normalizeTranscriptJson(content, 0) } catch { /* fall through to text formats */ }
  }
  if (fileName.toLowerCase().endsWith('.prtranscript')) {
    throw new Error('.prtranscript is a Premiere-only format RoughCut cannot read. In the Text panel use "Export to CSV File" instead, then load that.')
  }
  if (content.includes('-->')) return parseSrt(content, fps)
  return parseCsv(content, fps)
}
