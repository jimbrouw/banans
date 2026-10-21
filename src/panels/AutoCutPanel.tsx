import { useMemo, useState } from 'react'
import { AlertTriangle, Camera, Check, Lock, Scissors, Sparkles } from 'lucide-react'
import { Press } from '../ui'
import { errorMessage } from '../uiHelpers'
import { isPremiereHost, premiere } from '../premiereAdapter'
import { getAutopilotOptions } from '../autopilot'
import type { AutopilotOption } from '../autopilot'
import type { CutPoint, DetectedSources } from '../cutEngine'
import type { SpeakerMapping, TranscriptSegment } from '../types'
import { SpikePanel } from './SpikePanel'
import { PodcastMode } from './PodcastMode'
import type { MicSpeakers } from './PodcastMode'
import { hasSpeakerLabels } from '../podcastSpeakers'
import { logged } from '../runLog'

interface Props {
  sequenceId: string
  segments: TranscriptSegment[]
  mappings: SpeakerMapping[]
}

export function AutoCutPanel({ sequenceId, segments, mappings }: Props) {
  const [autoCutDet, setAutoCutDet] = useState<DetectedSources | null>(null)
  const [autoCutStatus, setAutoCutStatus] = useState<'idle' | 'detecting' | 'detected' | 'applying' | 'done' | 'error'>('idle')
  const [autoCutError, setAutoCutError] = useState('')
  const [autoCutResult, setAutoCutResult] = useState('')
  const [selectedAutopilotOptionId, setSelectedAutopilotOptionId] = useState<string | null>(null)
  const [micSpeakers, setMicSpeakers] = useState<MicSpeakers | null>(null) // Podcast Mode fallback: speakers from mic levels

  const detectCameras = async () => {
    try {
      setAutoCutError('')
      setAutoCutStatus('detecting')
      const det = await logged('Detect cameras', {}, () => premiere.detectSources(), (d) => `${d.sources.length} cameras · ${d.frameRate} fps · ${d.sources.map((s) => s.name).join(', ')}`)
      setAutoCutDet(det)
      setAutoCutStatus('detected')
    } catch (reason) {
      setAutoCutError(errorMessage(reason))
      setAutoCutStatus('error')
    }
  }

  const applyCuts = async (cuts: CutPoint[], endFrame: number, detail: string) => {
    try {
      setAutoCutError('')
      setAutoCutStatus('applying')
      const name = await logged('Auto Cut', { cuts: cuts.length, detail }, () => premiere.applyCutMap(sequenceId, cuts, autoCutDet!, endFrame, detail), (n) => n)
      setAutoCutResult(name)
      setAutoCutStatus('done')
    } catch (reason) {
      setAutoCutError(errorMessage(reason))
      setAutoCutStatus('error')
    }
  }

  const testAutoCut = () => {
    if (!autoCutDet) return
    const testCuts: CutPoint[] = [
      { frame: 0, camera: 1 },
      { frame: 150, camera: Math.min(2, autoCutDet.sources.length) },
      { frame: 300, camera: Math.min(3, autoCutDet.sources.length) },
      { frame: 450, camera: 1 },
    ]
    return applyCuts(testCuts, Math.min(600, autoCutDet.totalFrames), `test · ${testCuts.length} cuts`)
  }

  const applyAutopilot = (option: AutopilotOption) => {
    if (!autoCutDet) return
    return applyCuts(option.cuts, autoCutDet.totalFrames, `${option.profile.name.split(' ')[0]} · ${option.cuts.length} cuts · ${speakerSource}`)
  }

  const autopilotOptions = useMemo(() => {
    const speech = micSpeakers ?? { segments, mappings }
    if (!speech.segments.length || !autoCutDet) return []
    const sources = autoCutDet.sources.map(s => ({ camera: s.camera, name: s.name }))
    return getAutopilotOptions(speech.segments, speech.mappings, sources, autoCutDet.totalFrames, autoCutDet.frameRate)
  }, [segments, mappings, micSpeakers, autoCutDet])

  // Where the speaker turns came from, shown in the sequence name and the log.
  const speakerSource = micSpeakers ? 'mics' : hasSpeakerLabels(segments) ? 'labels' : 'rotation'
  const selectedOption = autopilotOptions.find(o => o.id === selectedAutopilotOptionId) || autopilotOptions[0]

  return (
    <section className="section">
      <div className="section-title"><h2>Auto-Cut Engine</h2><span className="hint">Phase 2 · Autopilot</span></div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Press className="primary" onClick={detectCameras} disabled={autoCutStatus === 'detecting' || autoCutStatus === 'applying'} style={{ flex: 1 }}>
          <Camera size={17} />{autoCutStatus === 'detecting' ? 'Detecting...' : 'Detect Cameras'}
        </Press>
        <Press className="primary" onClick={testAutoCut} disabled={!autoCutDet || autoCutStatus === 'applying'} style={{ flex: 1 }}>
          <Scissors size={17} />{autoCutStatus === 'applying' ? 'Applying...' : 'Test Auto-Cut'}
        </Press>
      </div>
      {autoCutDet && autoCutStatus !== 'error' && <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
        {autoCutDet.sources.length} cameras detected · {autoCutDet.frameRate} fps · {autoCutDet.totalFrames} frames · target V{autoCutDet.targetTrackIndex + 1}
        {autoCutDet.sources.map(s => <div key={s.camera} style={{ paddingLeft: 8 }}>C{s.camera}: {s.name} (V{s.vIndex + 1}, offset {s.clipStartFrame}f)</div>)}
      </div>}
      {autoCutDet && <PodcastMode det={autoCutDet} transcript={segments} active={!!micSpeakers} onChange={setMicSpeakers} />}

      {autopilotOptions.length > 0 && (
        <div className="autopilot-section">
          <h3 style={{ fontSize: 13 }}>Transcript Autopilot Options</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {autopilotOptions.map((opt) => (
              <Press
                key={opt.id}
                onClick={() => setSelectedAutopilotOptionId(opt.id)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 11px',
                  borderRadius: 7,
                  border: '1px solid',
                  borderColor: selectedOption.id === opt.id ? '#58a9e8' : '#343d3f',
                  backgroundColor: selectedOption.id === opt.id ? 'rgba(88, 169, 232, 0.12)' : '#121719',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'inherit'
                }}
              >
                <div>
                  <div style={{ fontWeight: 'bold', fontSize: 12 }}>{opt.profile.name}</div>
                  <div style={{ fontSize: 10, opacity: 0.7 }}>{opt.cuts.length} cuts generated</div>
                </div>
                <span style={{
                  fontWeight: 'bold',
                  fontSize: 12,
                  color: opt.score >= 90 ? '#69d59a' : opt.score >= 70 ? '#f0a13b' : '#ed7a13'
                }}>
                  Score: {opt.score}%
                </span>
              </Press>
            ))}
          </div>

          {selectedOption && (
            <div style={{ backgroundColor: '#121719', border: '1px solid #2a3133', padding: 10, borderRadius: 7, marginBottom: 8 }}>
              <p style={{ fontSize: 11, margin: '0 0 6px 0', opacity: 0.8 }}>{selectedOption.profile.description}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {selectedOption.checks.map((chk, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                    <span style={{ color: chk.pass ? '#69d59a' : '#ed7a13', fontWeight: 'bold' }}>
                      {chk.pass ? '✓' : '✗'}
                    </span>
                    <strong>{chk.label}:</strong>
                    <span style={{ opacity: 0.8 }}>{chk.detail}</span>
                  </div>
                ))}
              </div>

              <Press
                className="rough-cut"
                style={{ marginTop: 8, width: '100%' }}
                onClick={() => applyAutopilot(selectedOption)}
                disabled={autoCutStatus === 'applying'}
              >
                <Sparkles size={14} /> {autoCutStatus === 'applying' ? 'Applying...' : `Apply Autopilot Cut (${selectedOption.cuts.length} cuts)`}
              </Press>
            </div>
          )}
        </div>
      )}

      {autoCutStatus === 'done' && <div className="success"><Check size={16} />Created "{autoCutResult}". Open it in the Project panel.</div>}
      {autoCutError && <div className="error"><AlertTriangle size={16} />{autoCutError}</div>}
      <p className="safety"><Lock size={14} />Original sequence and audio stay untouched</p>

      {isPremiereHost() && <SpikePanel />}
    </section>
  )
}
