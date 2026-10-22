import { useMemo, useState } from 'react'
import { Check, Download, Sparkles } from 'lucide-react'
import { Press } from '../ui'
import { formatDuration, formatTime, markerMeta, platformColor, platformLabel } from '../uiHelpers'
import type { EditDecision, MarkerType } from '../types'

interface Props {
  decisions: EditDecision[]
  setDecisions: (update: (current: EditDecision[]) => EditDecision[]) => void
  sequenceName: string
  creating: boolean
  created: boolean
  onCreateRoughCut: () => void
}

export function ResultsPanel({ decisions, setDecisions, sequenceName, creating, created, onCreateRoughCut }: Props) {
  const [markerFilter, setMarkerFilter] = useState<'all' | 'promo' | 'shorts' | 'audio' | 'trims'>('all')
  const [sortBest, setSortBest] = useState(false)
  const selected = decisions.filter((d) => d.selected)
  const filteredDecisions = useMemo(() => {
    let list = decisions
    if (markerFilter === 'promo') list = decisions.filter((d) => ['social_clip', 'social_hook', 'audiogram'].includes(d.type))
    else if (markerFilter === 'shorts') list = decisions.filter((d) => d.platforms?.includes('shorts'))
    else if (markerFilter === 'audio') list = decisions.filter((d) => d.type === 'audiogram')
    else if (markerFilter === 'trims') list = decisions.filter((d) => d.type === 'suggested_trim')
    return sortBest ? [...list].sort((a, b) => (b.selfContainedScore ?? b.confidence) - (a.selfContainedScore ?? a.confidence)) : list
  }, [decisions, markerFilter, sortBest])
  const promoSummary = useMemo(() => ({
    shorts: decisions.filter((d) => d.platforms?.includes('shorts')).length,
    stories: decisions.filter((d) => d.platforms?.includes('stories') && !d.platforms?.includes('shorts')).length,
    audiograms: decisions.filter((d) => d.type === 'audiogram').length,
  }), [decisions])

  const exportPromoMap = () => {
    const promoTypes: MarkerType[] = ['social_clip', 'social_hook', 'audiogram']
    const clips = decisions.filter((d) => promoTypes.includes(d.type))
    const map = clips.map((d, i) => ({
      clip: String(i + 1).padStart(2, '0'),
      start: formatTime(d.start),
      end: d.end ? formatTime(d.end) : '',
      duration: formatDuration(d.start, d.end),
      idea: d.detail,
      type: d.type,
      platforms: d.platforms ?? [],
      selfContainedScore: d.selfContainedScore !== undefined ? `${Math.round(d.selfContainedScore * 100)}%` : '',
      versions: d.type === 'audiogram' ? ['audiogram'] : ['clean', 'captioned'],
      status: d.selected ? 'selected' : 'deselected',
    }))
    try {
      const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${sequenceName.replace(/\s+/g, '-')}-promo-map.json`; a.click()
      URL.revokeObjectURL(url)
    } catch { /* UXP file API not available in this context */ }
  }

  return (
    <>
      <div className="results-summary">
        <span><strong>{decisions.length}</strong> found{promoSummary.shorts ? `, ${promoSummary.shorts} work as Shorts` : ''}{promoSummary.audiograms ? `, ${promoSummary.audiograms} as audiograms` : ''}</span>
        <Press className="text-button" onClick={exportPromoMap}><Download size={13} /> Export list</Press>
      </div>
      <div className="marker-header"><span className="hint">Tick the ones to keep</span><Press className="text-button" onClick={() => setDecisions((current) => current.map((d) => ({ ...d, selected: true })))}>Select all</Press></div>
      <div className="filter-bar">
        {(['all', 'promo', 'shorts', 'audio', 'trims'] as const).map((f) => {
          const labels = { all: 'All', promo: 'Promo', shorts: 'Shorts', audio: 'Audio', trims: 'Trims' }
          const tabCounts = { all: decisions.length, promo: decisions.filter((d) => ['social_clip','social_hook','audiogram'].includes(d.type)).length, shorts: decisions.filter((d) => d.platforms?.includes('shorts')).length, audio: decisions.filter((d) => d.type === 'audiogram').length, trims: decisions.filter((d) => d.type === 'suggested_trim').length }
          return <Press key={f} className={`filter-tab${markerFilter === f ? ' active' : ''}`} onClick={() => { setMarkerFilter(f); if (f === 'promo') setSortBest(true) }}>{labels[f]} <span className="filter-count">{tabCounts[f]}</span></Press>
        })}
      </div>
      <div className="marker-col-header">
        <span className="col-clip">Clip</span>
        <Press className={`col-score${sortBest ? ' sorted' : ''}`} onClick={() => setSortBest((v) => !v)}>Score {sortBest ? '↓' : '↕'}</Press>
      </div>
      <div className="marker-list">{filteredDecisions.map((decision) => {
        const meta = markerMeta[decision.type]; const Icon = meta.icon
        const dur = formatDuration(decision.start, decision.end)
        const hasPromoMeta = decision.platforms && decision.platforms.length > 0
        return <Press className={`marker ${decision.selected ? 'selected' : ''}`} key={decision.id} onClick={() => setDecisions((current) => current.map((d) => d.id === decision.id ? { ...d, selected: !d.selected } : d))}>
          <span className="marker-check">{decision.selected && <Check size={13} />}</span>
          <i className="marker-line" style={{ background: meta.color }} />
          <Icon size={17} style={{ color: meta.color }} />
          <time>{formatTime(decision.start)}</time>
          <span className="marker-copy">
            <strong>{decision.label}</strong>
            <small>{decision.detail}</small>
            {hasPromoMeta && <span className="marker-plats">
              {dur && <span className="clip-dur">{dur}</span>}
              {decision.platforms!.map((p) => <span key={p} className="plat-badge" style={{ color: platformColor[p], borderColor: platformColor[p] }}>{platformLabel[p]}</span>)}
              {decision.selfContainedScore !== undefined && <span className="sc-score" style={{ color: decision.selfContainedScore >= 0.7 ? '#69d59a' : 'var(--muted)' }}>SC {Math.round(decision.selfContainedScore * 100)}</span>}
            </span>}
          </span>
          <em style={{ color: meta.color }}>{Math.round(decision.confidence * 100)}%</em>
        </Press>
      })}</div>
      <Press className="primary results-action" disabled={!selected.length || creating} onClick={onCreateRoughCut}><Sparkles size={17} />{creating ? 'Adding markers…' : created ? 'Markers added to a copy' : `Mark ${selected.length} on a copy of the sequence`}</Press>
    </>
  )
}
