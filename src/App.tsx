import { useEffect, useState } from 'react'
import { Check, Clapperboard, Lock } from 'lucide-react'
import { analyseTranscript } from './analyse'
import { sequence as demoSequence } from './mockPremiere'
import { isPremiereHost, premiere } from './premiereAdapter'
import { errorMessage } from './uiHelpers'
import { logged, logPath, writeLog } from './runLog'
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
  const selected = decisions.filter((d) => d.selected)

  useEffect(() => {
    premiere.getActiveSequence()
      .then(async (activeSequence) => {
        setSequence(activeSequence); setStatus('ready')
        writeLog({ at: new Date(), status: 'INFO', action: 'Panel opened', details: { sequence: activeSequence.name, host: isPremiereHost() ? 'premiere' : 'browser', log: await logPath() ?? 'console' } })
      })
      .catch((reason: unknown) => { setError(errorMessage(reason)); setStatus('error') })
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
      await logged('Review Markers', { source: sequence.name, markers: selected.length }, () => premiere.createRoughCut(sequence.id, selected, mappings), (n) => n)
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

        <SequencePanel sequence={sequence} loading={status === 'loading'} />
        <SpeakerMappingPanel mappings={mappings} onChange={updateMapping} />
        <AnalysisPanel settings={settings} onPatch={patchSettings} busy={busy} buttonLabel={analyseLabel} error={error} onAnalyse={runAnalysis} />
        <ReviewPanel sequenceId={sequence.id} />

        {decisions.length > 0 && <section className="section results">
          <ResultsPanel decisions={decisions} setDecisions={setDecisions} sequenceName={sequence.name} creating={status === 'creating'} created={status === 'created'} onCreateRoughCut={createRoughCut} />
          <ColdOpenPanel sequenceId={sequence.id} segments={segments} />
          <p className="safety"><Lock size={14} /> Original sequence stays untouched</p>
          {status === 'created' && <div className="success"><Check size={16} /> Action completed. Check the Project panel for your new sequence.</div>}
        </section>}

        <AutoCutPanel sequenceId={sequence.id} segments={segments} mappings={mappings} />
      </section>
    </main>
  )
}
