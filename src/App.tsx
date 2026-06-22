import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Camera, Check, ChevronDown, Clapperboard, FileText, Film, Lock, Play, Quote, Scissors, Sparkles } from 'lucide-react'
import { analyseTranscript } from './analyse'
import { sequence as demoSequence } from './mockPremiere'
import { isPremiereHost, premiere } from './premiereAdapter'
import type { AnalysisSettings, EditDecision, MarkerType, SequenceInfo, SpeakerMapping, TranscriptSegment } from './types'
import type { CutPoint, DetectedSources } from './cutEngine'
import { getAutopilotOptions } from './autopilot'
import type { AutopilotOption } from './autopilot'
import './App.css'

const markerMeta: Record<MarkerType, { name: string; color: string; icon: typeof Sparkles }> = {
  social_clip: { name: 'Strong clip', color: '#69d59a', icon: Sparkles },
  chapter: { name: 'Chapter', color: '#58a9e8', icon: Film },
  suggested_trim: { name: 'Trim', color: '#ed7a13', icon: Scissors },
  warning: { name: 'Warning', color: '#e5bd53', icon: AlertTriangle },
  strong_quote: { name: 'Quote', color: '#f0a13b', icon: Quote },
  camera_switch: { name: 'Camera', color: '#52cbc7', icon: Camera },
  social_hook: { name: 'Hook', color: '#b57bed', icon: Sparkles },
}

const formatTime = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 19)
const cameras = ['Camera 1', 'Camera 2', 'Wide']

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return <button className={`toggle ${checked ? 'on' : ''}`} onClick={onChange} aria-pressed={checked}><span /></button>
}

export default function App() {
  const [settings, setSettings] = useState<AnalysisSettings>({ socialClips: true, chapters: true, suggestedTrims: true, pauseMarkers: true, cameraPlan: true, minimumClipSeconds: 15, confidenceThreshold: .6, minimumPauseSeconds: 1.2, minimumShotSeconds: 2.5, fillerAggressiveness: 'medium' })
  const [sequence, setSequence] = useState<SequenceInfo>(demoSequence)
  const [mappings, setMappings] = useState<SpeakerMapping[]>([{ speaker: 'Host', camera: 'Camera 1' }, { speaker: 'Guest', camera: 'Camera 2' }])
  const [decisions, setDecisions] = useState<EditDecision[]>([])
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'analysing' | 'results' | 'creating' | 'created' | 'error'>('loading')
  const [error, setError] = useState('')
  const [autoCutDet, setAutoCutDet] = useState<DetectedSources | null>(null)
  const [autoCutStatus, setAutoCutStatus] = useState<'idle' | 'detecting' | 'detected' | 'applying' | 'done' | 'error'>('idle')
  const [autoCutError, setAutoCutError] = useState('')
  const [autoCutResult, setAutoCutResult] = useState('')
  const [selectedAutopilotOptionId, setSelectedAutopilotOptionId] = useState<string | null>(null)
  const selected = decisions.filter((d) => d.selected)
  const counts = useMemo(() => Object.keys(markerMeta).map((type) => ({ type: type as MarkerType, count: decisions.filter((d) => d.type === type).length })).filter((x) => x.count), [decisions])

  useEffect(() => {
    premiere.getActiveSequence()
      .then((activeSequence) => { setSequence(activeSequence); setStatus('ready') })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); setStatus('error') })
  }, [])

  const analyseSegments = async (transcript: TranscriptSegment[]) => {
    setSegments(transcript)
    const speakers = [...new Set(transcript.map((segment) => segment.speaker))]
    const resolvedMappings = speakers.map((speaker, index) => mappings.find((mapping) => mapping.speaker === speaker) ?? { speaker, camera: index === 0 ? 'Camera 1' : index === 1 ? 'Camera 2' : 'Wide' })
    setMappings(resolvedMappings)
    const nextDecisions = await analyseTranscript(transcript, settings, resolvedMappings)
    if (!nextDecisions.length) throw new Error('No decisions matched the current analysis settings. Lower the confidence threshold or minimum clip length.')
    setDecisions(nextDecisions)
    setStatus('results')
  }

  const runAnalysis = async (loadFromFile = false) => {
    try {
      setError('')
      setStatus('analysing')
      const transcript = loadFromFile ? await premiere.importTranscriptFile() : await premiere.getTranscript(sequence.id)
      if (!transcript.length) { setStatus(decisions.length ? 'results' : 'ready'); return }
      await analyseSegments(transcript)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setStatus('error')
    }
  }

  const createRoughCut = async () => {
    try {
      setError('')
      setStatus('creating')
      await premiere.createRoughCut(sequence.id, selected, mappings)
      setStatus('created')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setStatus('error')
    }
  }

  const updateMapping = (speaker: string, camera: string) => setMappings((current) => current.map((m) => m.speaker === speaker ? { ...m, camera } : m))
  const patchSettings = (patch: Partial<AnalysisSettings>) => setSettings((current) => ({ ...current, ...patch }))

  const detectCameras = async () => {
    try {
      setAutoCutError('')
      setAutoCutStatus('detecting')
      const det = await premiere.detectSources()
      setAutoCutDet(det)
      setAutoCutStatus('detected')
    } catch (reason) {
      setAutoCutError(reason instanceof Error ? reason.message : String(reason))
      setAutoCutStatus('error')
    }
  }

  const testAutoCut = async () => {
    if (!autoCutDet) return
    try {
      setAutoCutError('')
      setAutoCutStatus('applying')
      const testEndFrame = Math.min(600, autoCutDet.totalFrames)
      const testCuts: CutPoint[] = [
        { frame: 0, camera: 1 },
        { frame: 150, camera: Math.min(2, autoCutDet.sources.length) },
        { frame: 300, camera: Math.min(3, autoCutDet.sources.length) },
        { frame: 450, camera: 1 },
      ]
      const name = await premiere.applyCutMap(sequence.id, testCuts, autoCutDet, testEndFrame)
      setAutoCutResult(name)
      setAutoCutStatus('done')
    } catch (reason) {
      setAutoCutError(reason instanceof Error ? reason.message : String(reason))
      setAutoCutStatus('error')
    }
  }

  const autopilotOptions = useMemo(() => {
    if (!segments.length || !autoCutDet) return []
    const sources = autoCutDet.sources.map(s => ({ camera: s.camera, name: s.name }))
    return getAutopilotOptions(segments, mappings, sources, autoCutDet.totalFrames, autoCutDet.frameRate)
  }, [segments, mappings, autoCutDet])

  const applyAutopilot = async (option: AutopilotOption) => {
    if (!autoCutDet) return
    try {
      setAutoCutError('')
      setAutoCutStatus('applying')
      const name = await premiere.applyCutMap(
        sequence.id,
        option.cuts,
        autoCutDet,
        autoCutDet.totalFrames
      )
      setAutoCutResult(name)
      setAutoCutStatus('done')
    } catch (reason) {
      setAutoCutError(reason instanceof Error ? reason.message : String(reason))
      setAutoCutStatus('error')
    }
  }

  const assembleColdOpen = async () => {
    if (!autoCutDet) {
      setError('Please run "Detect Cameras" first in the Auto-Cut section so we know your camera offsets.')
      return
    }
    const selectedHooks = selected.filter(d => d.type === 'social_hook')
    if (selectedHooks.length === 0) {
      setError('Please select at least one Inquisitive Hook in the results below.')
      return
    }
    try {
      setError('')
      setStatus('creating')
      const name = await premiere.assembleSocialSequence(sequence.id, selectedHooks, mappings, autoCutDet)
      setAutoCutResult(name)
      setAutoCutStatus('done')
      setStatus('created')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setStatus('error')
    }
  }

  const selectedOption = autopilotOptions.find(o => o.id === selectedAutopilotOptionId) || autopilotOptions[0]


  return (
    <main className="app-shell">
      <section className="panel" aria-label="RoughCut podcast edit assistant">
        <header><div className="brand-mark"><Clapperboard size={19} /></div><div><h1>RoughCut</h1><p>Podcast Edit Assistant</p></div><span className="host-label">{isPremiereHost() ? 'PREMIERE PRO' : 'BROWSER DEMO'}</span></header>

        <section className="section sequence-section">
          <div className="section-title"><h2>Active sequence</h2><span className="live-dot">Connected</span></div>
          <button className="sequence-row"><Film size={20} /><strong>{sequence.name}</strong><ChevronDown size={17} /></button>
          <div className="transcript-row"><span className="check-icon"><Check size={14} /></span><strong>{status === 'loading' ? 'Connecting...' : 'Sequence ready'}</strong><span>{Math.floor(sequence.duration / 60)}:{String(sequence.duration % 60).padStart(2, '0')}{sequence.transcriptCoverage ? ` · ${sequence.transcriptCoverage}% demo coverage` : ''}</span></div>
        </section>

        <section className="section">
          <div className="section-title"><h2>Speaker mapping</h2><button className="text-button">Auto-detect</button></div>
          <div className="mapping-list">
            {mappings.map((mapping, index) => <div className="mapping" key={mapping.speaker}><span className="speaker-dot" style={{ background: index ? '#52cbc7' : '#58a9e8' }} /><strong>{mapping.speaker}</strong><span className="maps-to">maps to</span><select value={mapping.camera} onChange={(e) => updateMapping(mapping.speaker, e.target.value)}>{cameras.map((camera) => <option key={camera}>{camera}</option>)}</select></div>)}
            <div className="mapping"><span className="speaker-dot wide" /><strong>Fallback</strong><span className="maps-to">uses</span><select defaultValue="Wide">{cameras.map((camera) => <option key={camera}>{camera}</option>)}</select></div>
          </div>
        </section>

        <section className="section">
          <div className="section-title"><h2>Analysis</h2><span className="hint">Editor-controlled suggestions</span></div>
          <div className="analysis-options">
            <label><div><strong>Social clips</strong><span>Find self-contained moments</span></div><Toggle checked={settings.socialClips} onChange={() => patchSettings({ socialClips: !settings.socialClips })} /></label>
            <label><div><strong>Chapters</strong><span>Detect topic changes</span></div><Toggle checked={settings.chapters} onChange={() => patchSettings({ chapters: !settings.chapters })} /></label>
            <label><div><strong>Suggested trims</strong><span>Find pauses, filler and repeats</span></div><Toggle checked={settings.suggestedTrims} onChange={() => patchSettings({ suggestedTrims: !settings.suggestedTrims })} /></label>
            <label><div><strong>Pause markers</strong><span>Flag transcript gaps for review</span></div><Toggle checked={settings.pauseMarkers} onChange={() => patchSettings({ pauseMarkers: !settings.pauseMarkers })} /></label>
            <label><div><strong>Camera plan</strong><span>Respect sustained speaker turns</span></div><Toggle checked={settings.cameraPlan} onChange={() => patchSettings({ cameraPlan: !settings.cameraPlan })} /></label>
          </div>
          <div className="compact-settings">
            <label>Minimum clip <select value={settings.minimumClipSeconds} onChange={(e) => patchSettings({ minimumClipSeconds: Number(e.target.value) })}><option value="15">15s</option><option value="30">30s</option><option value="45">45s</option></select></label>
            <label>Confidence <select value={settings.confidenceThreshold} onChange={(e) => patchSettings({ confidenceThreshold: Number(e.target.value) })}><option value=".6">60%+</option><option value=".75">75%+</option><option value=".9">90%+</option></select></label>
            <label>Pause length <select value={settings.minimumPauseSeconds} onChange={(e) => patchSettings({ minimumPauseSeconds: Number(e.target.value) })}><option value=".8">0.8s</option><option value="1.2">1.2s</option><option value="2">2.0s</option></select></label>
            <label>Minimum shot <select value={settings.minimumShotSeconds} onChange={(e) => patchSettings({ minimumShotSeconds: Number(e.target.value) })}><option value="1.5">1.5s</option><option value="2.5">2.5s</option><option value="4">4.0s</option></select></label>
            <label>Filler scan <select value={settings.fillerAggressiveness} onChange={(e) => patchSettings({ fillerAggressiveness: e.target.value as AnalysisSettings['fillerAggressiveness'] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          </div>
          <button className="primary" onClick={() => runAnalysis()} disabled={status === 'loading' || status === 'analysing' || status === 'creating'}><Play size={17} fill="currentColor" />{status === 'loading' ? 'Connecting to Premiere...' : status === 'analysing' ? 'Analysing transcript...' : decisions.length ? 'Analyse again' : 'Analyse transcript'}</button>
          <button className="text-button file-import" onClick={() => runAnalysis(true)} disabled={status === 'loading' || status === 'analysing' || status === 'creating'}><FileText size={15} /> Load transcript file</button>
          {error && <div className="error"><AlertTriangle size={16} />{error}</div>}
        </section>

        {decisions.length > 0 && <section className="section results">
          <div className="result-heading"><div className="score">{Math.round(decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length * 100)}%</div><div><h2>{decisions.length} edit decisions</h2><p>{selected.length} selected for write-back</p></div></div>
          <div className="count-row">{counts.map(({ type, count }) => <span key={type}><i style={{ background: markerMeta[type].color }} />{count} {markerMeta[type].name}</span>)}</div>
          <div className="marker-header"><h2>Proposed markers</h2><button className="text-button" onClick={() => setDecisions((current) => current.map((d) => ({ ...d, selected: true })))}>Select all</button></div>
          <div className="marker-list">{decisions.map((decision) => { const meta = markerMeta[decision.type]; const Icon = meta.icon; return <button className={`marker ${decision.selected ? 'selected' : ''}`} key={decision.id} onClick={() => setDecisions((current) => current.map((d) => d.id === decision.id ? { ...d, selected: !d.selected } : d))}><span className="marker-check">{decision.selected && <Check size={13} />}</span><i className="marker-line" style={{ background: meta.color }} /><Icon size={17} style={{ color: meta.color }} /><time>{formatTime(decision.start)}</time><span className="marker-copy"><strong>{decision.label}</strong><small>{decision.detail}</small></span><em style={{ color: meta.color }}>{Math.round(decision.confidence * 100)}%</em></button>})}</div>
          <button className="rough-cut" disabled={!selected.length || status === 'creating'} onClick={createRoughCut}><Sparkles size={19} />{status === 'creating' ? 'Building review cut...' : status === 'created' ? 'Marked review cut created' : `Create Marked Review Cut (${selected.length})`}</button>
          {selected.some(d => d.type === 'social_hook') && (
            <button className="rough-cut" style={{ marginTop: 8, background: '#b57bed' }} disabled={status === 'creating'} onClick={assembleColdOpen}>
              <Sparkles size={19} />{status === 'creating' ? 'Assembling Cold Open...' : `Assemble YouTube Cold Open (${selected.filter(d => d.type === 'social_hook').length})`}
            </button>
          )}
          <p className="safety"><Lock size={14} /> Original sequence stays untouched</p>
          {status === 'created' && <div className="success"><Check size={16} /> Action completed. Check the Project panel for your new sequence.</div>}
        </section>}
      </section>

        <section className="section">
          <div className="section-title"><h2>Auto-Cut Engine</h2><span className="hint">Phase 2 · Autopilot</span></div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button className="primary" onClick={detectCameras} disabled={autoCutStatus === 'detecting' || autoCutStatus === 'applying'} style={{ flex: 1 }}>
              <Camera size={17} />{autoCutStatus === 'detecting' ? 'Detecting...' : 'Detect Cameras'}
            </button>
            <button className="primary" onClick={testAutoCut} disabled={!autoCutDet || autoCutStatus === 'applying'} style={{ flex: 1 }}>
              <Scissors size={17} />{autoCutStatus === 'applying' ? 'Applying...' : 'Test Auto-Cut'}
            </button>
          </div>
          {autoCutDet && autoCutStatus !== 'error' && <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
            {autoCutDet.sources.length} cameras detected · {autoCutDet.frameRate} fps · {autoCutDet.totalFrames} frames · target V{autoCutDet.targetTrackIndex + 1}
            {autoCutDet.sources.map(s => <div key={s.camera} style={{ paddingLeft: 8 }}>C{s.camera}: {s.name} (V{s.vIndex + 1}, offset {s.clipStartFrame}f)</div>)}
          </div>}

          {autopilotOptions.length > 0 && (
            <div className="autopilot-section" style={{ borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: 10, marginTop: 10 }}>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Transcript Autopilot Options</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                {autopilotOptions.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setSelectedAutopilotOptionId(opt.id)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 10px',
                      borderRadius: 4,
                      border: '1px solid',
                      borderColor: selectedOption.id === opt.id ? '#58a9e8' : 'rgba(0,0,0,0.15)',
                      background: selectedOption.id === opt.id ? 'rgba(88, 169, 232, 0.1)' : 'transparent',
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
                  </button>
                ))}
              </div>

              {selectedOption && (
                <div style={{ background: 'rgba(0,0,0,0.03)', padding: 8, borderRadius: 4, marginBottom: 8 }}>
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

                  <button
                    className="rough-cut"
                    style={{ marginTop: 8, width: '100%', padding: '6px 12px' }}
                    onClick={() => applyAutopilot(selectedOption)}
                    disabled={autoCutStatus === 'applying'}
                  >
                    <Sparkles size={14} /> {autoCutStatus === 'applying' ? 'Applying...' : `Apply Autopilot Cut (${selectedOption.cuts.length} cuts)`}
                  </button>
                </div>
              )}
            </div>
          )}

          {autoCutStatus === 'done' && <div className="success"><Check size={16} />Created "{autoCutResult}". Open it in the Project panel.</div>}
          {autoCutError && <div className="error"><AlertTriangle size={16} />{autoCutError}</div>}
          <p className="safety"><Lock size={14} />Original sequence and audio stay untouched</p>
        </section>
      </main>
    )
  }
