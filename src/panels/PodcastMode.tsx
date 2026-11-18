import { useState } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { Press } from '../ui'
import { errorMessage } from '../uiHelpers'
import { ENGINE_OFF_MESSAGE, engineHealth, micLevels } from '../engineClient'
import type { DetectedSources } from '../cutEngine'
import { detectSpeakers, placeEnvelope, talkShare, turnsToSegments } from '../podcastSpeakers'
import type { Envelope } from '../podcastSpeakers'
import type { SourceClip } from '../reviewModel'
import { getAudioTracks } from '../reviewHost'
import { demoMicEnvelopes } from '../reviewDemo'
import { writeLog } from '../runLog'
import type { TranscriptSegment } from '../types'

const RATE = 10

/** Speaker turns detected from mic loudness, and the camera each mic's speaker is on. */
export interface MicSpeakers { segments: TranscriptSegment[]; cameras: Record<string, number> }
interface Row { track: number; channel: number | null; camera: number }
type Track = { index: number; clips: SourceClip[] }

const rowLabel = (r: Row, i: number) => `Mic ${i + 1} (A${r.track + 1}${r.channel === null ? '' : ` ch ${r.channel + 1}`})`

/**
 * Podcast Mode's mic option: who's talking, from each mic track's loudness.
 * For when Premiere's transcript has no speaker labels (or they're wrong).
 */
export function MicSpeakersStep({ det, trackLabel, onChange }: { det: DetectedSources; trackLabel: (camera: number) => string; onChange: (result: MicSpeakers | null) => void }) {
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const demo = tracks !== null && tracks[0]?.clips[0]?.path.startsWith('/demo/')

  const findTracks = async () => {
    try {
      setError('')
      const found = await getAudioTracks() ?? [0, 1].map((index) => ({ index, clips: [{ path: `/demo/mic${index + 1}.wav`, start: 0, end: det.totalFrames / det.frameRate, inPoint: 0 }] }))
      if (!found.length) throw new Error('No audio tracks with clips on this sequence.')
      setTracks(found)
      const cams = det.sources.map((s) => s.camera)
      // One stereo track with two mics on L/R is common, so split it by channel.
      setRows(found.length === 1 && cams.length >= 2
        ? [{ track: found[0].index, channel: 0, camera: cams[0] }, { track: found[0].index, channel: 1, camera: cams[1] }]
        : found.slice(0, Math.max(2, cams.length - 1)).map((t, i) => ({ track: t.index, channel: null, camera: cams[Math.min(i, cams.length - 1)] })))
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const detect = async () => {
    if (!tracks) return
    try {
      setError(''); setBusy(true)
      const duration = det.totalFrames / det.frameRate
      let envelopes: number[][]
      if (demo) {
        envelopes = demoMicEnvelopes(duration).slice(0, rows.length)
      } else {
        if (!await engineHealth()) throw new Error(`Mic detection needs the local engine. ${ENGINE_OFF_MESSAGE}`)
        envelopes = []
        for (const row of rows) {
          const clips = tracks.find((t) => t.index === row.track)?.clips ?? []
          const byPath = new Map<string, Envelope>()
          for (const path of new Set(clips.map((c) => c.path))) byPath.set(path, await micLevels(path, row.channel))
          envelopes.push(placeEnvelope(clips, byPath, duration, RATE))
        }
      }
      const turns = detectSpeakers(envelopes, RATE)
      const labels = rows.map(rowLabel)
      const segments = turnsToSegments(labels, turns)
      if (!segments.length) throw new Error('No speech found on those mic tracks. Check the tracks and channels.')
      onChange({ segments, cameras: Object.fromEntries(rows.map((r, i) => [labels[i], r.camera])) })
      const text = talkShare(turns).map((share, i) => `Mic ${i + 1}: ${Math.round(share * 100)}% of talk, ${turns[i].length} turns`).join('. ')
      setSummary(text)
      writeLog({ at: new Date(), status: 'OK', action: 'Detect speakers', result: text, details: { mics: rows.map((r, i) => `${rowLabel(r, i)}→${trackLabel(r.camera).split(' ')[0]}`).join(', ') } })
    } catch (reason) {
      setError(errorMessage(reason))
      writeLog({ at: new Date(), status: 'FAIL', action: 'Detect speakers', details: { error: errorMessage(reason) } })
    } finally {
      setBusy(false)
    }
  }

  const patchRow = (i: number, p: Partial<Row>) => { setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r))); onChange(null); setSummary('') }

  if (!tracks) return <>
    <p className="lede">Works out who's talking from each person's mic. Needs one mic per track, or per channel.</p>
    <Press className="secondary" onClick={findTracks}>Choose mic tracks</Press>
    {error && <div className="error"><AlertTriangle size={15} />{error}</div>}
  </>

  return (
    <>
      <div className="map-rows">
        {rows.map((r, i) => (
          <div className="map-row mic-row" key={i}>
            <span className="who">Mic {i + 1}</span>
            <select value={r.track} onChange={(e) => patchRow(i, { track: Number(e.target.value) })} aria-label={`Mic ${i + 1} track`}>{tracks.map((t) => <option key={t.index} value={t.index}>A{t.index + 1}</option>)}</select>
            <select value={r.channel ?? ''} onChange={(e) => patchRow(i, { channel: e.target.value === '' ? null : Number(e.target.value) })} aria-label={`Mic ${i + 1} channel`}>
              <option value="">Both channels</option>{[0, 1, 2, 3].map((c) => <option key={c} value={c}>Channel {c + 1}</option>)}
            </select>
            <select value={r.camera} onChange={(e) => patchRow(i, { camera: Number(e.target.value) })} aria-label={`Mic ${i + 1} camera`}>{det.sources.map((s) => <option key={s.camera} value={s.camera}>{trackLabel(s.camera)}</option>)}</select>
            {rows.length > 2 && <Press className="mic-remove" onClick={() => { setRows((rs) => rs.filter((_, j) => j !== i)); onChange(null) }}><X size={12} /></Press>}
          </div>
        ))}
      </div>
      <div className="row-actions">
        <Press className="text-button" onClick={() => setRows((rs) => [...rs, { track: tracks[0].index, channel: null, camera: det.sources[0].camera }])}><Plus size={13} /> Add a mic</Press>
        <Press className="secondary small" disabled={busy || rows.length < 2} onClick={detect}>{busy ? 'Listening…' : 'Find who talks when'}</Press>
      </div>
      {summary && <p className="footnote">{summary}</p>}
      {error && <div className="error"><AlertTriangle size={15} />{error}</div>}
    </>
  )
}
