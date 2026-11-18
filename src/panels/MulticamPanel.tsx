import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Camera, Scissors } from 'lucide-react'
import { Press } from '../ui'
import { errorMessage } from '../uiHelpers'
import { premiere } from '../premiereAdapter'
import { getAutopilotOptions } from '../autopilot'
import type { CutPoint, DetectedSources } from '../cutEngine'
import type { SpeakerMapping, TranscriptSegment } from '../types'
import { hasSpeakerLabels } from '../podcastSpeakers'
import { logged } from '../runLog'
import { MicSpeakersStep } from './PodcastMode'
import type { MicSpeakers } from './PodcastMode'

interface Props {
  sequenceId: string
  transcript: TranscriptSegment[]
  onReadTranscript: () => Promise<void>
  onCreated: (name: string) => void
  onStatus: (status: string) => void
}

type SpeakerSource = 'transcript' | 'mics'
const trackLabel = (det: DetectedSources, camera: number) => {
  const s = det.sources.find((x) => x.camera === camera)
  return s ? `V${s.vIndex + 1}  ${s.name}` : `Camera ${camera}`
}

/** Talk time per labelled speaker. */
function speakersOf(transcript: TranscriptSegment[]): { name: string; share: number }[] {
  const totals = new Map<string, number>()
  for (const s of transcript) if (s.speaker && s.speaker !== 'Unknown') totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start))
  const all = [...totals.values()].reduce((a, b) => a + b, 0) || 1
  // By name, so Speaker 1 comes before Speaker 2 and defaults to V1.
  return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([name, t]) => ({ name, share: t / all }))
}

export function MulticamPanel({ sequenceId, transcript, onReadTranscript, onCreated, onStatus }: Props) {
  const [det, setDet] = useState<DetectedSources | null>(null)
  const [busy, setBusy] = useState<'' | 'detecting' | 'reading' | 'applying'>('')
  const [error, setError] = useState('')
  const [source, setSource] = useState<SpeakerSource>('transcript')
  const [cameraFor, setCameraFor] = useState<Record<string, number>>({}) // speaker → camera number
  const [wide, setWide] = useState<number | null>(null)
  const [mics, setMics] = useState<MicSpeakers | null>(null)
  const [styleId, setStyleId] = useState<string | null>(null)

  const speakers = useMemo(() => speakersOf(transcript), [transcript])
  const labelled = hasSpeakerLabels(transcript)

  useEffect(() => { onStatus(det ? `${det.sources.length} cams` : '') }, [det, onStatus])

  // Sensible defaults once both cameras and speakers are known: speakers take the
  // single-person cameras in order, the last camera is the wide shot.
  const defaults = useMemo(() => {
    if (!det) return { wide: 1, map: {} as Record<string, number> }
    const last = det.sources[det.sources.length - 1].camera
    const singles = det.sources.map((s) => s.camera).filter((c) => det.sources.length < 3 || c !== last)
    return { wide: last, map: Object.fromEntries(speakers.map((s, i) => [s.name, singles[i % singles.length]])) as Record<string, number> }
  }, [det, speakers])
  const wideCamera = wide ?? defaults.wide
  const cameraOf = (speaker: string) => cameraFor[speaker] ?? defaults.map[speaker] ?? 1

  const detect = async () => {
    try {
      setError(''); setBusy('detecting')
      setDet(await logged('Detect cameras', {}, () => premiere.detectSources(), (d) => `${d.sources.length} cameras · ${d.frameRate} fps · ${d.sources.map((s) => `V${s.vIndex + 1} ${s.name}`).join(', ')}`))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  const readTranscript = async () => {
    try { setError(''); setBusy('reading'); await onReadTranscript() } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  // The autopilot finds cameras by name, and the wide shot by the name "Wide".
  // So each camera is named by number, and the chosen wide camera "Wide".
  const speech = useMemo(() => {
    const nameOf = (camera: number) => (camera === wideCamera ? 'Wide' : `cam-${camera}`)
    const segments = source === 'mics' ? mics?.segments : labelled ? transcript : undefined
    if (!det || !segments) return null
    const assigned = source === 'mics' ? Object.entries(mics!.cameras) : speakers.map((s) => [s.name, cameraFor[s.name] ?? defaults.map[s.name] ?? 1] as const)
    const mappings: SpeakerMapping[] = assigned.map(([speaker, cam]) => ({ speaker, camera: nameOf(cam) }))
    const sources = det.sources.map((s) => ({ camera: s.camera, name: nameOf(s.camera) }))
    const summary = [...assigned.map(([speaker, cam]) => `${speaker}→V${det.sources.find((x) => x.camera === cam)!.vIndex + 1}`), `wide→V${det.sources.find((x) => x.camera === wideCamera)!.vIndex + 1}`].join(', ')
    return { styles: getAutopilotOptions(segments, mappings, sources, det.totalFrames, det.frameRate), summary }
  }, [det, source, mics, labelled, transcript, speakers, cameraFor, defaults, wideCamera])
  const styles = speech?.styles ?? []
  const style = styles.find((o) => o.id === styleId) ?? styles[0]

  const apply = async (cuts: CutPoint[], endFrame: number, detail: string, mapping: string) => {
    try {
      setError(''); setBusy('applying')
      onCreated(await logged('Auto Cut', { cuts: cuts.length, detail, mapping }, () => premiere.applyCutMap(sequenceId, cuts, det!, endFrame, detail), (n) => n))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  const testCut = () => {
    if (!det) return
    const n = det.sources.length
    const cuts: CutPoint[] = [{ frame: 0, camera: 1 }, { frame: 150, camera: Math.min(2, n) }, { frame: 300, camera: Math.min(3, n) }, { frame: 450, camera: 1 }]
    return apply(cuts, Math.min(600, det.totalFrames), `test · ${cuts.length} cuts`, 'test')
  }

  const trackOptions = det?.sources.map((s) => <option key={s.camera} value={s.camera}>{trackLabel(det, s.camera)}</option>)

  return (
    <div className="tab-body">
      <ol className="steps">
        <li className={`step ${det ? 'done' : 'current'}`}>
          <div className="step-head"><strong>Cameras</strong>{det && <Press className="text-button" onClick={detect} disabled={!!busy}>Detect again</Press>}</div>
          {!det
            ? <>
                <p className="lede">One camera per video track, from V1 up, each with one full-length clip.</p>
                <Press className="primary" onClick={detect} disabled={!!busy}><Camera size={17} />{busy === 'detecting' ? 'Looking at the tracks…' : 'Detect cameras'}</Press>
              </>
            : <ul className="track-list">{det.sources.map((s) => <li key={s.camera}><span className="track-tag">V{s.vIndex + 1}</span>{s.name}</li>)}</ul>}
        </li>

        <li className={`step ${!det ? 'waiting' : speech ? 'done' : 'current'}`}>
          <div className="step-head">
            <strong>Who's on which camera</strong>
            {det && <span className="segmented" role="tablist">
              <Press className={source === 'transcript' ? 'on' : ''} onClick={() => setSource('transcript')}>Transcript</Press>
              <Press className={source === 'mics' ? 'on' : ''} onClick={() => setSource('mics')}>Mic tracks</Press>
            </span>}
          </div>
          {det && source === 'transcript' && (
            !transcript.length
              ? <>
                  <p className="lede">Uses the speakers in Premiere's transcript (Text panel).</p>
                  <Press className="secondary" onClick={readTranscript} disabled={!!busy}>{busy === 'reading' ? 'Reading…' : 'Read speakers from transcript'}</Press>
                </>
              : !labelled
                ? <p className="lede">Premiere's transcript doesn't separate speakers. Turn on speaker labels when you transcribe in Premiere, or use Mic tracks.</p>
                : <div className="map-rows">
                    {speakers.map((s) => (
                      <label className="map-row" key={s.name}>
                        <span className="who">{s.name}<small>{Math.round(s.share * 100)}% of talk</small></span>
                        <select value={cameraOf(s.name)} onChange={(e) => setCameraFor((m) => ({ ...m, [s.name]: Number(e.target.value) }))}>{trackOptions}</select>
                      </label>
                    ))}
                  </div>
          )}
          {det && source === 'mics' && <MicSpeakersStep det={det} trackLabel={(c) => trackLabel(det, c)} onChange={setMics} />}
          {det && <label className="map-row wide-row">
            <span className="who">Wide shot<small>when people talk over each other</small></span>
            <select value={wideCamera} onChange={(e) => setWide(Number(e.target.value))}>{trackOptions}</select>
          </label>}
        </li>

        <li className={`step ${styles.length ? 'current' : 'waiting'}`}>
          <div className="step-head"><strong>Cut style</strong></div>
          {styles.length > 0 && style && <>
            <div className="choice-list">
              {styles.map((o) => (
                <Press key={o.id} className={`choice ${o.id === style.id ? 'on' : ''}`} onClick={() => setStyleId(o.id)}>
                  <span>{o.profile.name.split(' ')[0]}</span>
                  <small>{o.cuts.length} cuts, shots at least {o.profile.minShotSeconds}s</small>
                </Press>
              ))}
            </div>
            <Press className="primary" disabled={!!busy} onClick={() => apply(style.cuts, det!.totalFrames, `${style.profile.name.split(' ')[0]} · ${style.cuts.length} cuts · ${source === 'mics' ? 'mics' : 'labels'}`, speech!.summary)}>
              <Scissors size={17} />{busy === 'applying' ? 'Cutting…' : `Cut to a new sequence`}
            </Press>
            <p className="footnote">Your sequence stays as it is. Overlaps cut to the wide shot.</p>
          </>}
        </li>
      </ol>
      {error && <div className="error"><AlertTriangle size={16} />{error}</div>}
      {det && <Press className="text-button quiet-link" disabled={!!busy} onClick={testCut}>Make a 20-second test cut</Press>}
    </div>
  )
}
