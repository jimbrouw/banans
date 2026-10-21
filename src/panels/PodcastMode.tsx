import { useState } from 'react'
import { AlertTriangle, Mic, Plus, X } from 'lucide-react'
import { Press } from '../ui'
import { errorMessage } from '../uiHelpers'
import { engineHealth, micLevels } from '../engineClient'
import type { DetectedSources } from '../cutEngine'
import { detectSpeakers, hasSpeakerLabels, placeEnvelope, talkShare, turnsToSegments } from '../podcastSpeakers'
import type { Envelope } from '../podcastSpeakers'
import type { SourceClip } from '../reviewModel'
import { getAudioTracks } from '../reviewHost'
import { demoMicEnvelopes } from '../reviewDemo'
import type { SpeakerMapping, TranscriptSegment } from '../types'

const RATE = 10

export interface MicSpeakers { segments: TranscriptSegment[]; mappings: SpeakerMapping[] }
interface Row { track: number; channel: number | null; camera: number }
type Track = { index: number; clips: SourceClip[] }

const rowLabel = (r: Row, i: number) => `Mic ${i + 1} (A${r.track + 1}${r.channel === null ? '' : ` ch ${r.channel + 1}`})`

/**
 * Who's talking, for the multicam autopilot. Premiere's speaker labels first;
 * when there are none (or the editor prefers it), each mic track's loudness.
 */
export function PodcastMode({ det, transcript, active, onChange }: { det: DetectedSources; transcript: TranscriptSegment[]; active: boolean; onChange: (result: MicSpeakers | null) => void }) {
  const labelled = hasSpeakerLabels(transcript)
  const [showMics, setShowMics] = useState(!labelled)
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const demo = tracks !== null && tracks.length > 0 && tracks[0].clips[0]?.path.startsWith('/demo/')

  const findTracks = async () => {
    try {
      setError('')
      const found = await getAudioTracks() ?? [0, 1].map((index) => ({ index, clips: [{ path: `/demo/mic${index + 1}.wav`, start: 0, end: det.totalFrames / det.frameRate, inPoint: 0 }] }))
      if (!found.length) throw new Error('No audio tracks with clips on this sequence.')
      setTracks(found)
      const cams = det.sources.length
      // One stereo track with two mics on L/R is common, so split it by channel.
      setRows(found.length === 1 && cams >= 2
        ? [{ track: found[0].index, channel: 0, camera: 1 }, { track: found[0].index, channel: 1, camera: 2 }]
        : found.slice(0, Math.max(2, cams)).map((t, i) => ({ track: t.index, channel: null, camera: Math.min(i + 1, cams) })))
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
        if (!await engineHealth()) throw new Error('Mic detection needs the local engine. In Terminal: cd engine && uv run roughcut-engine')
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
      const cameraName = (n: number) => det.sources.find((s) => s.camera === n)?.name ?? `Camera ${n}`
      const segments = turnsToSegments(labels, turns)
      if (!segments.length) throw new Error('No speech found on those mic tracks. Check the tracks and channels.')
      onChange({ segments, mappings: rows.map((r, i) => ({ speaker: labels[i], camera: cameraName(r.camera) })) })
      setSummary(talkShare(turns).map((share, i) => `${labels[i]} ${Math.round(share * 100)}% · ${turns[i].length} turns`).join('  ·  '))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const patchRow = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)))

  return (
    <div className="podcast-mode">
      <div className="ai-pass-head"><Mic size={15} /><strong>Podcast Mode</strong><span className="hint">who's talking</span></div>
      {labelled && !showMics
        ? <>
            <p className="hint">Using Premiere's speaker labels ({[...new Set(transcript.map((s) => s.speaker))].filter((s) => s !== 'Unknown').join(', ')}). Map them to cameras under Speaker mapping.</p>
            <Press className="text-button" onClick={() => setShowMics(true)}>Use mic tracks instead</Press>
          </>
        : <>
            <p className="hint">{labelled ? 'Detect speakers from each mic’s volume instead of Premiere’s labels.' : transcript.length ? 'Premiere’s transcript has no speaker labels, so detect them from each mic’s volume.' : 'Detect speakers from each mic’s volume (or analyse a transcript with speaker labels above).'}</p>
            {!tracks
              ? <Press className="text-button" onClick={findTracks}><Mic size={14} /> Find mic tracks</Press>
              : <>
                  <div className="mic-rows">
                    {rows.map((r, i) => (
                      <div className="mic-row" key={i}>
                        <strong>Mic {i + 1}</strong>
                        <select value={r.track} onChange={(e) => patchRow(i, { track: Number(e.target.value) })}>{tracks.map((t) => <option key={t.index} value={t.index}>A{t.index + 1}</option>)}</select>
                        <select value={r.channel ?? ''} onChange={(e) => patchRow(i, { channel: e.target.value === '' ? null : Number(e.target.value) })}>
                          <option value="">Mix</option>{[0, 1, 2, 3].map((c) => <option key={c} value={c}>Ch {c + 1}</option>)}
                        </select>
                        <span className="maps-to">→</span>
                        <select value={r.camera} onChange={(e) => patchRow(i, { camera: Number(e.target.value) })}>{det.sources.map((s) => <option key={s.camera} value={s.camera}>{s.name}</option>)}</select>
                        {rows.length > 2 && <Press className="mic-remove" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><X size={12} /></Press>}
                      </div>
                    ))}
                  </div>
                  <div className="mic-actions">
                    <Press className="text-button" onClick={() => setRows((rs) => [...rs, { track: tracks[0].index, channel: null, camera: 1 }])}><Plus size={13} /> Add mic</Press>
                    <Press className="text-button" disabled={busy || rows.length < 2} onClick={detect}>{busy ? 'Listening…' : 'Detect speakers'}</Press>
                  </div>
                  {summary && active && <p className="hint ai-note">{summary}</p>}
                </>}
            {labelled && <Press className="text-button" onClick={() => { setShowMics(false); setSummary(''); onChange(null) }}>Use Premiere’s labels instead</Press>}
          </>}
      {error && <div className="error"><AlertTriangle size={15} />{error}</div>}
    </div>
  )
}
