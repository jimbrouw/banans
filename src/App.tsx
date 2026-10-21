import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Clapperboard, Lock } from 'lucide-react'
import { analyseTranscript } from './analyse'
import { sequence as demoSequence } from './mockPremiere'
import { isPremiereHost, premiere } from './premiereAdapter'
import { errorMessage } from './uiHelpers'
import { isRunning, logged, logPath, writeLog } from './runLog'
import type { AnalysisSettings, EditDecision, SequenceInfo, SpeakerMapping, TranscriptSegment } from './types'
import { SequencePanel, SpeakerMappingPanel } from './panels/SequencePanel'
import { AnalysisPanel } from './panels/AnalysisPanel'
import { ResultsPanel } from './panels/ResultsPanel'
import { ColdOpenPanel } from './panels/ColdOpenPanel'
import { AutoCutPanel } from './panels/AutoCutPanel'
import { EngineStatus } from './panels/EngineStatus'
import { ReviewPanel } from './panels/ReviewPanel'

import './App.css'

export default function App() {
  const [settings, setSettings] = useState<AnalysisSettings>({ socialClips: true, chapters: true, suggestedTrims: true, pauseMarkers: true, cameraPlan: true, minimumClipSeconds: 15, confidenceThreshold: .6, minimumPauseSeconds: 1.2, minimumShotSeconds: 2.5, fillerAggressiveness: 'medium' })
  const [sequence, setSequence] = useState<SequenceInfo>(demoSequence)
  const [mappings, setMappings] = useState<SpeakerMapping[]>([{ speaker: 'Host', camera: 'Camera 1' }, { speaker: 'Guest', camera: 'Camera 2' }])
  const [decisions, setDecisions] = useState<EditDecision[]>([])
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'analysing' | 'results' | 'creating' | 'created' | 'error'>('loading')
  const [error, setError] = useState('')
  const [sequences, setSequences] = useState<{ id: string; name: string }[]>([])
  const [lastCreated, setLastCreated] = useState('')
  const sequenceId = useRef('')
  const selected = decisions.filter((d) => d.selected)

  // Follow Premiere's active sequence. Results belong to one sequence, so a switch
  // clears them (panels below are keyed by sequence id and start fresh). Never
  // switch mid-action: actions like Auto Cut open the sequence they create.
  const followTimeline = useCallback(async () => {
    if (isRunning()) return
    try {
      const active = await premiere.getActiveSequence()
      setSequences(await premiere.listSequences())
      if (active.id === sequenceId.current) return
      const first = sequenceId.current === ''
      sequenceId.current = active.id
      setSequence(active); setDecisions([]); setSegments([]); setError(''); setStatus('ready')
      writeLog(first
        ? { at: new Date(), status: 'INFO', action: 'Panel opened', details: { sequence: active.name, host: isPremiereHost() ? 'premiere' : 'browser', log: await logPath() ?? 'console' } }
        : { at: new Date(), status: 'INFO', action: 'Sequence changed', details: { sequence: active.name } })
    } catch (reason) {
      if (sequenceId.current === '') { setError(errorMessage(reason)); setStatus('error') }
    }
  }, [])

  useEffect(() => {
    const first = setTimeout(followTimeline, 0)
    const stopWatching = premiere.watchActiveSequence(() => { followTimeline() })
    const timer = setInterval(followTimeline, 1500) // safety net if the event doesn't fire
    return () => { clearTimeout(first); stopWatching(); clearInterval(timer) }
  }, [followTimeline])

  const chooseSequence = async (id: string) => {
    try {
      await premiere.activateSequence(id)
      await followTimeline()
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }


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
      const transcript = await logged('Analyse', { sequence: sequence.name, from: loadFromFile ? 'file' : 'premiere' },
        () => loadFromFile ? premiere.importTranscriptFile() : premiere.getTranscript(sequence.id),
        (t) => `${t.length} segments · ${new Set(t.map((x) => x.speaker)).size} speakers`)
      if (!transcript.length) { setStatus(decisions.length ? 'results' : 'ready'); return }
      await analyseSegments(transcript)
    } catch (reason) {
      setError(errorMessage(reason))
      setStatus('error')
    }
  }

  const createRoughCut = async () => {
    try {
      setError('')
      setStatus('creating')
      setLastCreated(await logged('Review Markers', { source: sequence.name, markers: selected.length }, () => premiere.createRoughCut(sequence.id, selected, mappings), (n) => n))
      setStatus('created')
    } catch (reason) {
      setError(errorMessage(reason))
      setStatus('error')
    }
  }

  const updateMapping = (speaker: string, camera: string) => setMappings((current) => current.map((m) => m.speaker === speaker ? { ...m, camera } : m))
  const patchSettings = (patch: Partial<AnalysisSettings>) => setSettings((current) => ({ ...current, ...patch }))
  const busy = status === 'loading' || status === 'analysing' || status === 'creating'
  const analyseLabel = status === 'loading' ? 'Connecting to Premiere...' : status === 'analysing' ? 'Analysing transcript...' : decisions.length ? 'Analyse again' : 'Analyse transcript'

  return (
    <main className="app-shell">
      <section className="panel" aria-label="RoughCut podcast edit assistant">
        <header><div className="brand-mark"><Clapperboard size={19} /></div><div><h1>RoughCut</h1><p>Podcast Edit Assistant</p></div><span className="host-label">{isPremiereHost() ? 'PREMIERE PRO' : 'BROWSER DEMO'}</span><EngineStatus /></header>

        <SequencePanel sequence={sequence} sequences={sequences} loading={status === 'loading'} onSelect={chooseSequence} />
        {lastCreated && <div className="success created-banner"><Check size={16} /> Created "{lastCreated}" (in the RoughCut bin, now open in the Timeline)</div>}
        <SpeakerMappingPanel mappings={mappings} onChange={updateMapping} />
        <AnalysisPanel settings={settings} onPatch={patchSettings} busy={busy} buttonLabel={analyseLabel} error={error} onAnalyse={runAnalysis} />
        <ReviewPanel key={`review-${sequence.id}`} sequenceId={sequence.id} onCreated={setLastCreated} />

        {decisions.length > 0 && <section className="section results">
          <ResultsPanel decisions={decisions} setDecisions={setDecisions} sequenceName={sequence.name} creating={status === 'creating'} created={status === 'created'} onCreateRoughCut={createRoughCut} />
          <ColdOpenPanel key={`cold-${sequence.id}`} sequenceId={sequence.id} segments={segments} onCreated={setLastCreated} />
          <p className="safety"><Lock size={14} /> Original sequence stays untouched</p>
          {status === 'created' && <div className="success"><Check size={16} /> Action completed. Check the Project panel for your new sequence.</div>}
        </section>}

        <AutoCutPanel key={`autocut-${sequence.id}`} sequenceId={sequence.id} segments={segments} mappings={mappings} onCreated={setLastCreated} />
      </section>
    </main>
  )
}
