import { AlertTriangle, FileText, Play } from 'lucide-react'
import { Options, Press, Toggle } from '../ui'
import type { AnalysisSettings } from '../types'

interface Props {
  settings: AnalysisSettings
  onPatch: (patch: Partial<AnalysisSettings>) => void
  busy: boolean
  buttonLabel: string
  error: string
  onAnalyse: (loadFromFile?: boolean) => void
  hasResults: boolean
}

export function AnalysisPanel({ settings, onPatch, busy, buttonLabel, error, onAnalyse, hasResults }: Props) {
  const on = [settings.socialClips && 'clips', settings.chapters && 'chapters', settings.suggestedTrims && 'trims', settings.pauseMarkers && 'pauses', settings.cameraPlan && 'camera plan'].filter(Boolean)
  return (
    <div className="block">
      {hasResults
        ? <Press className="text-button" onClick={() => onAnalyse()} disabled={busy}><Play size={13} /> {buttonLabel}</Press>
        : <>
            <p className="lede">Reads Premiere's transcript and marks social clips, quotes and chapters on a copy of the sequence.</p>
            <Press className="primary" onClick={() => onAnalyse()} disabled={busy}><Play size={17} fill="currentColor" />{buttonLabel}</Press>
          </>}
      <Options summary={`Finding ${on.join(', ') || 'nothing'}`}>
        <div className="analysis-options">
          <label><div><strong>Social clips</strong><span>Self-contained moments</span></div><Toggle checked={settings.socialClips} onChange={() => onPatch({ socialClips: !settings.socialClips })} /></label>
          <label><div><strong>Chapters</strong><span>Topic changes</span></div><Toggle checked={settings.chapters} onChange={() => onPatch({ chapters: !settings.chapters })} /></label>
          <label><div><strong>Suggested trims</strong><span>Pauses, filler and repeats</span></div><Toggle checked={settings.suggestedTrims} onChange={() => onPatch({ suggestedTrims: !settings.suggestedTrims })} /></label>
          <label><div><strong>Pause markers</strong><span>Gaps in the transcript</span></div><Toggle checked={settings.pauseMarkers} onChange={() => onPatch({ pauseMarkers: !settings.pauseMarkers })} /></label>
          <label><div><strong>Camera plan</strong><span>Markers for speaker turns</span></div><Toggle checked={settings.cameraPlan} onChange={() => onPatch({ cameraPlan: !settings.cameraPlan })} /></label>
        </div>
        <div className="compact-settings">
          <label>Shortest clip <select value={settings.minimumClipSeconds} onChange={(e) => onPatch({ minimumClipSeconds: Number(e.target.value) })}><option value="15">15s</option><option value="30">30s</option><option value="45">45s</option></select></label>
          <label>Confidence <select value={settings.confidenceThreshold} onChange={(e) => onPatch({ confidenceThreshold: Number(e.target.value) })}><option value="0.6">60%+</option><option value="0.75">75%+</option><option value="0.9">90%+</option></select></label>
          <label>Pause length <select value={settings.minimumPauseSeconds} onChange={(e) => onPatch({ minimumPauseSeconds: Number(e.target.value) })}><option value="0.8">0.8s</option><option value="1.2">1.2s</option><option value="2">2.0s</option></select></label>
          <label>Shortest shot <select value={settings.minimumShotSeconds} onChange={(e) => onPatch({ minimumShotSeconds: Number(e.target.value) })}><option value="1.5">1.5s</option><option value="2.5">2.5s</option><option value="4">4.0s</option></select></label>
          <label>Filler scan <select value={settings.fillerAggressiveness} onChange={(e) => onPatch({ fillerAggressiveness: e.target.value as AnalysisSettings['fillerAggressiveness'] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        </div>
        <Press className="text-button" onClick={() => onAnalyse(true)} disabled={busy}><FileText size={14} /> Use a transcript file instead</Press>
      </Options>
      {error && <div className="error"><AlertTriangle size={16} />{error}</div>}
    </div>
  )
}
