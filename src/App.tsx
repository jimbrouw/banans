import { useCallback, useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { analyseTranscript } from './analyse'
import { sequence as demoSequence } from './mockPremiere'
import { isPremiereHost, premiere } from './premiereAdapter'
import { errorMessage } from './uiHelpers'
import { isRunning, logged, logPath, writeLog } from './runLog'
import { readSetting, SETTINGS, writeSetting } from './settings'
import type { AnalysisSettings, EditDecision, SequenceInfo, SpeakerMapping, TranscriptSegment } from './types'
import { SequencePicker, TabBar } from './panels/Chrome'
import { AnalysisPanel } from './panels/AnalysisPanel'
import { ResultsPanel } from './panels/ResultsPanel'
import { ColdOpenPanel } from './panels/ColdOpenPanel'
import { MulticamPanel } from './panels/MulticamPanel'
import { EngineStatus } from './panels/EngineStatus'
import { ReviewPanel } from './panels/ReviewPanel'
import { SetupPanel } from './panels/SetupPanel'
import { SelectsPanel } from './panels/SelectsPanel'
import { Options } from './ui'

import './App.css'

type TabId = 'cleanup' | 'multicam' | 'clips' | 'setup'
const TAB_IDS: TabId[] = ['cleanup', 'multicam', 'clips', 'setup']

// Markers for the camera plan only need a stable speaker → camera guess;
// real camera mapping happens in the Multicam tab against detected tracks.
const markerMappings = (speakers: string[]): SpeakerMapping[] =>
  speakers.map((speaker, i) => ({ speaker, camera: i === 0 ? 'Camera 1' : i === 1 ? 'Camera 2' : 'Wide' }))

export default function App() {
  const [settings, setSettings] = useState<AnalysisSettings>({ socialClips: true, chapters: true, suggestedTrims: true, pauseMarkers: true, cameraPlan: true, minimumClipSeconds: 15, confidenceThreshold: .6, minimumPauseSeconds: 1.2, minimumShotSeconds: 2.5, fillerAggressiveness: 'medium' })
  const [sequence, setSequence] = useState<SequenceInfo>(demoSequence)
  const [decisions, setDecisions] = useState<EditDecision[]>([])
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'analysing' | 'results' | 'creating' | 'created' | 'error'>('loading')
  const [error, setError] = useState('')
  const [sequences, setSequences] = useState<{ id: string; name: string }[]>([])
  const [lastCreated, setLastCreated] = useState('')
  const [tab, setTab] = useState<TabId>(() => { const t = readSetting(SETTINGS.tab, 'cleanup') as TabId; return TAB_IDS.includes(t) ? t : 'cleanup' })
  const [tabStatus, setTabStatus] = useState<Partial<Record<TabId, string>>>({})
  const sequenceId = useRef('')
  const selected = decisions.filter((d) => d.selected)
  const mappings = markerMappings([...new Set(segments.map((s) => s.speaker))])

  const statusFor = (id: TabId) => (text: string) => setTabStatus((s) => (s[id] === text ? s : { ...s, [id]: text }))
  // Stable callbacks so the panels' status effects don't re-run on every render.
  const [cleanupStatus] = useState(() => statusFor('cleanup'))
  const [multicamStatus] = useState(() => statusFor('multicam'))

  // Follow Premiere's active sequence. Results belong to one sequence, so a switch
  // clears them (panels are keyed by sequence id and start fresh). Never switch
  // mid-action: actions like Auto Cut open the sequence they create.
  const followTimeline = useCallback(async () => {
    if (isRunning()) return
    try {
      const active = await premiere.getActiveSequence()
      setSequences(await premiere.listSequences())
      if (active.id === sequenceId.current) return
      const first = sequenceId.current === ''
      sequenceId.current = active.id
      setSequence(active); setDecisions([]); setSegments([]); setError(''); setStatus('ready'); setTabStatus({})
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

  const chooseTab = (id: string) => { setTab(id as TabId); writeSetting(SETTINGS.tab, id) }

  const readTranscript = async (loadFromFile = false) => {
    const transcript = await logged('Read transcript', { sequence: sequence.name, from: loadFromFile ? 'file' : 'premiere' },
      () => loadFromFile ? premiere.importTranscriptFile() : premiere.getTranscript(sequence.id),
      (t) => `${t.length} segments · ${new Set(t.map((x) => x.speaker)).size} speakers`)
    if (transcript.length) setSegments(transcript)
    return transcript
  }

  const runAnalysis = async (loadFromFile = false) => {
    try {
      setError('')
      setStatus('analysing')
      const transcript = await readTranscript(loadFromFile)
      if (!transcript.length) { setStatus(decisions.length ? 'results' : 'ready'); return }
      const nextDecisions = await analyseTranscript(transcript, settings, markerMappings([...new Set(transcript.map((s) => s.speaker))]))
      if (!nextDecisions.length) throw new Error('Nothing matched the current options. Lower the confidence or the shortest clip length under Options.')
      setDecisions(nextDecisions)
      setStatus('results')
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

  const patchSettings = (patch: Partial<AnalysisSettings>) => setSettings((current) => ({ ...current, ...patch }))
  const busy = status === 'loading' || status === 'analysing' || status === 'creating'
  const analyseLabel = status === 'loading' ? 'Connecting to Premiere…' : status === 'analysing' ? 'Reading the transcript…' : decisions.length ? 'Find again' : 'Find clips and chapters'

  const tabs = [
    { id: 'cleanup', label: 'Clean up', status: tabStatus.cleanup },
    { id: 'multicam', label: 'Multicam', status: tabStatus.multicam },
    { id: 'clips', label: 'Clips', status: tabStatus.clips },
    { id: 'setup', label: 'Setup' },
  ]
  const show = (id: TabId) => ({ className: 'tab-panel', role: 'tabpanel', style: id === tab ? undefined : { display: 'none' } })

  return (
    <main className="app-shell">
      <section className="panel" aria-label="RoughCut">
        <header className="topbar">
          <span className="wordmark">RoughCut</span>
          <SequencePicker sequence={sequence} sequences={sequences} onSelect={chooseSequence} />
          <EngineStatus />
        </header>
        <TabBar tabs={tabs} active={tab} onChange={chooseTab} />
        {lastCreated && <div className="created-banner"><Check size={14} /><span>Created <strong>{lastCreated}</strong>, now open in the Timeline</span></div>}

        <div {...show('cleanup')}>
          <ReviewPanel key={`review-${sequence.id}`} sequenceId={sequence.id} onCreated={setLastCreated} onStatus={cleanupStatus} />
        </div>
        <div {...show('multicam')}>
          <MulticamPanel key={`multicam-${sequence.id}`} sequenceId={sequence.id} transcript={segments} onReadTranscript={async () => { await readTranscript() }} onCreated={setLastCreated} onStatus={multicamStatus} />
        </div>
        <div {...show('clips')}>
          <div className="tab-body">
            <SelectsPanel key={`selects-${sequence.id}`} onCreated={setLastCreated} />
            <div className="block">
              <Options label="Review markers" summary="Off. Turn on for the full marker list and cold opens">
                <AnalysisPanel settings={settings} onPatch={patchSettings} busy={busy} buttonLabel={analyseLabel} error={error} onAnalyse={runAnalysis} hasResults={decisions.length > 0} />
                {decisions.length > 0 && <div className="block results">
                  <ResultsPanel decisions={decisions} setDecisions={setDecisions} sequenceName={sequence.name} creating={status === 'creating'} created={status === 'created'} onCreateRoughCut={createRoughCut} />
                  <ColdOpenPanel key={`cold-${sequence.id}`} sequenceId={sequence.id} segments={segments} onCreated={setLastCreated} />
                </div>}
              </Options>
            </div>
          </div>
        </div>
        <div {...show('setup')}>
          <SetupPanel />
        </div>
      </section>
    </main>
  )
}
