import type { SequenceInfo } from '../types'

interface Props {
  sequence: SequenceInfo
  sequences: { id: string; name: string }[]
  onSelect: (id: string) => void
}

const length = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/** Header picker. Follows Premiere's active sequence; choosing one opens it in the Timeline. */
export function SequencePicker({ sequence, sequences, onSelect }: Props) {
  return (
    <label className="sequence-picker" title={`${sequence.name}, ${length(sequence.duration)} long. Follows the Timeline.`}>
      <select value={sequence.id} onChange={(e) => onSelect(e.target.value)} aria-label="Sequence">
        {!sequences.some((s) => s.id === sequence.id) && <option value={sequence.id}>{sequence.name}</option>}
        {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  )
}

export interface Tab { id: string; label: string; status?: string }

/** Tabs carry their live state (cut count, cameras) so you can see where each job is. */
export function TabBar({ tabs, active, onChange }: { tabs: Tab[]; active: string; onChange: (id: string) => void }) {
  return (
    <nav className="tabbar" role="tablist">
      {tabs.map((t) => (
        <span key={t.id} role="tab" tabIndex={0} aria-selected={t.id === active} className={`tab ${t.id === active ? 'on' : ''}`}
          onClick={() => onChange(t.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onChange(t.id) }}>
          {t.label}{t.status && <small>{t.status}</small>}
        </span>
      ))}
    </nav>
  )
}
