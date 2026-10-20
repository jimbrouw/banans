import { AlertTriangle, FileText, Play } from 'lucide-react'
import { Press, Toggle } from '../ui'
import type { AnalysisSettings } from '../types'

interface Props {
  settings: AnalysisSettings
  onPatch: (patch: Partial<AnalysisSettings>) => void
  busy: boolean
  buttonLabel: string
  error: string
  onAnalyse: (loadFromFile?: boolean) => void
}

export function AnalysisPanel({ settings, onPatch, busy, buttonLabel, error, onAnalyse }: Props) {
  return (
    <section className="section">
      <div className="section-title"><h2>Analysis</h2><span className="hint">Editor-controlled suggestions</span></div>
      <div className="analysis-options">
        <label><div><strong>Social clips</strong><span>Find self-contained moments</span></div><Toggle checked={settings.socialClips} onChange={() => onPatch({ socialClips: !settings.socialClips })} /></label>
        <label><div><strong>Chapters</strong><span>Detect topic changes</span></div><Toggle checked={settings.chapters} onChange={() => onPatch({ chapters: !settings.chapters })} /></label>
        <label><div><strong>Suggested trims</strong><span>Find pauses, filler and repeats</span></div><Toggle checked={settings.suggestedTrims} onChange={() => onPatch({ suggestedTrims: !settings.suggestedTrims })} /></label>
        <label><div><strong>Pause markers</strong><span>Flag transcript gaps for review</span></div><Toggle checked={settings.pauseMarkers} onChange={() => onPatch({ pauseMarkers: !settings.pauseMarkers })} /></label>
        <label><div><strong>Camera plan</strong><span>Respect sustained speaker turns</span></div><Toggle checked={settings.cameraPlan} onChange={() => onPatch({ cameraPlan: !settings.cameraPlan })} /></label>
      </div>
      <div className="compact-settings">
        <label>Minimum clip <select value={settings.minimumClipSeconds} onChange={(e) => onPatch({ minimumClipSeconds: Number(e.target.value) })}><option value="15">15s</option><option value="30">30s</option><option value="45">45s</option></select></label>
        <label>Confidence <select value={settings.confidenceThreshold} onChange={(e) => onPatch({ confidenceThreshold: Number(e.target.value) })}><option value=".6">60%+</option><option value=".75">75%+</option><option value=".9">90%+</option></select></label>
        <label>Pause length <select value={settings.minimumPauseSeconds} onChange={(e) => onPatch({ minimumPauseSeconds: Number(e.target.value) })}><option value=".8">0.8s</option><option value="1.2">1.2s</option><option value="2">2.0s</option></select></label>
        <label>Minimum shot <select value={settings.minimumShotSeconds} onChange={(e) => onPatch({ minimumShotSeconds: Number(e.target.value) })}><option value="1.5">1.5s</option><option value="2.5">2.5s</option><option value="4">4.0s</option></select></label>
        <label>Filler scan <select value={settings.fillerAggressiveness} onChange={(e) => onPatch({ fillerAggressiveness: e.target.value as AnalysisSettings['fillerAggressiveness'] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      </div>
      <Press className="primary" onClick={() => onAnalyse()} disabled={busy}><Play size={17} fill="currentColor" />{buttonLabel}</Press>
      <Press className="text-button file-import" onClick={() => onAnalyse(true)} disabled={busy}><FileText size={15} /> Load transcript file</Press>
      {error && <div className="error"><AlertTriangle size={16} />{error}</div>}
    </section>
  )
}
